// 全页面文本对比度扫描：不预设选择器，而是遍历页面上所有「自己带文字」的可见元素，
// 逐个算有效对比度，再按 (前景色, 最坏背景色, 字号档) 去重，避免同一规则刷屏。
// 目的是抓「同类问题」，而不是只修被点名的那个类名。

const parseColor = (value) => {
  const m = /rgba?\(([^)]+)\)/i.exec(value ?? '')
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}
const over = (src, dst) => ({
  r: src.r * src.a + dst.r * (1 - src.a),
  g: src.g * src.a + dst.g * (1 - src.a),
  b: src.b * src.a + dst.b * (1 - src.a),
  a: 1,
})
const luminance = ({ r, g, b }) => {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (fg, bg) => {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}
const rgbStr = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`

function backgroundCandidates(el) {
  const layers = []
  let node = el
  while (node && node.nodeType === 1) {
    const cs = getComputedStyle(node)
    const solid = parseColor(cs.backgroundColor)
    const stops = []
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      for (const m of cs.backgroundImage.matchAll(/rgba?\([^)]+\)/gi)) {
        const c = parseColor(m[0])
        if (c && c.a > 0) stops.push(c)
      }
    }
    const hasSolid = solid && solid.a > 0
    layers.push({ solid: hasSolid ? solid : null, stops })
    if (hasSolid && solid.a === 1) break
    node = node.parentElement
  }
  let below = { r: 255, g: 255, b: 255, a: 1 }
  const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor)
  if (bodyBg && bodyBg.a === 1) below = bodyBg
  let candidates = [below]
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i]
    const next = []
    for (const c of candidates) {
      const layerBase = L.solid ? (L.solid.a === 1 ? L.solid : over(L.solid, c)) : c
      if (L.stops.length) for (const s of L.stops) next.push(over(s, layerBase))
      else next.push(layerBase)
    }
    candidates = next.length ? next : candidates
  }
  return candidates
}

const hasOwnText = (el) =>
  // 阈值从 >1 放宽到 >=1：单字符文本（统计卡片里的 "0" / "1"、CJK 单字）同样是真实文字，
  // 原来会被静默跳过 —— vault 统计区那些「浅底浅字」的数字就是这样漏过审计的。
  Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length >= 1)

const kill = document.createElement('style')
kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
document.head.appendChild(kill)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function sweep(pageLabel, theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const seen = new Map()
  let scanned = 0
  for (const el of document.querySelectorAll('body *')) {
    if (!hasOwnText(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue
    const fg = parseColor(cs.color)
    if (!fg) continue
    const fontPx = parseFloat(cs.fontSize)
    if (!(fontPx >= 10)) continue
    scanned++
    const bold = parseInt(cs.fontWeight, 10) >= 700
    // WCAG：大字号阈值 24px，或 18.66px 且加粗
    const large = fontPx >= 24 || (fontPx >= 18.66 && bold)
    const threshold = large ? 3.0 : 4.5
    // 渐变文字（background-clip: text）：真正的「文字色」是那块渐变，不是 computed color
    // （后者被 -webkit-text-fill-color: transparent 置空，只是个继承来的占位）。原实现会把
    // 渐变当成**背景**层参与合成，再用占位色去比 —— 既可能误报也可能漏报。
    // 正确做法：渐变各色标才是前景，逐一与元素**真正背后的**底色比，取最差值。
    const clip = cs.webkitBackgroundClip || cs.getPropertyValue('-webkit-background-clip')
    const fill = (cs.webkitTextFillColor ?? cs.getPropertyValue('-webkit-text-fill-color')) || 'rgba(0, 0, 0, 0)'
    const fillC = parseColor(fill)
    const isGradientText = clip === 'text' && cs.backgroundImage !== 'none' && (!fillC || fillC.a === 0)
    const gradStops = []
    if (isGradientText) {
      for (const m of cs.backgroundImage.matchAll(/rgba?\([^)]+\)/gi)) {
        const c = parseColor(m[0])
        if (c && c.a > 0) gradStops.push(c)
      }
    }
    // 渐变文字时要把元素自身的渐变层排除出「背景候选」，否则底色会被自己的字色污染
    const cands = isGradientText ? backgroundCandidates(el.parentElement ?? el) : backgroundCandidates(el)
    const fgs = isGradientText && gradStops.length ? gradStops : [fg]
    let worst = Infinity
    let worstBg = null
    let worstFg = fgs[0]
    for (const c of cands) {
      for (const f of fgs) {
        const fgOn = f.a < 1 ? over(f, c) : f
        const r = contrast(fgOn, c)
        if (r < worst) {
          worst = r
          worstBg = c
          worstFg = f
        }
      }
    }
    const key = `${theme}|${cs.color}|${rgbStr(worstBg)}|${Math.round(fontPx)}|${bold}`
    const entry = seen.get(key) ?? {
      page: pageLabel,
      theme,
      sel: el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase(),
      sample: (el.textContent ?? '').trim().slice(0, 16),
      fg: isGradientText ? `${rgbStr(worstFg)} (渐变文字最差色标)` : cs.color,
      bg: rgbStr(worstBg),
      fontPx: Math.round(fontPx * 10) / 10,
      bold,
      threshold,
      ratio: Math.round(worst * 100) / 100,
      count: 0,
    }
    entry.count++
    seen.set(key, entry)
  }
  return { page: pageLabel, theme, scanned, entries: Array.from(seen.values()) }
}

/* 页面切换必须按 **hash 路由 key**，不能用导航文本子串匹配。
   为什么：侧栏 `.nav-item` 的文本是「标签 + 描述」拼接（App.tsx 里 nav-label + nav-desc），
   实测 '沙箱' 与 '市场' 互相命中、'设置' 命中系统任务页、'任务' 命中市场页描述，
   9 个页面只走到 5 个，审计会**假达标**（layout-audit 同样中招）。
   App.tsx 的 NAV 给出稳定 key，getPageFromHash 接受 `#/key`，因此这里只写 key。
   判定「真的到了」也不看文案，而看 KeepAlive 渲染出的 `[data-page-container=key]` 是否可见，
   这样切换语言（i18n）也不会让覆盖面静默缩水 —— 上一版正是踩了「按中文标签反查」的坑，
   '插件分配' 与 '分配' 不相等，导致 allocations / kernels 两页被误判为不可达。 */
const PAGES = ['console', 'profiles', 'tasks', 'market', 'vault', 'allocations', 'kernels', 'dsh-envs', 'settings']
const currentPageLabel = () => (document.querySelector('.nav-item.active')?.textContent ?? 'current').trim().slice(0, 14)

/** 页面真的挂载且可见：KeepAlive 只把非活动页设成 display:none，故可见即为当前页。 */
const isOnPage = (key) => {
  const box = document.querySelector(`[data-page-container="${key}"]`)
  return !!box && box.style.display !== 'none'
}

async function gotoTab(key) {
  if (location.hash.replace(/^#\/?/, '') !== key) location.hash = `#/${key}`
  // 等 hashchange → setPage → KeepAlive 挂载/显隐 → 该页异步数据落定
  for (let i = 0; i < 40; i++) {
    await wait(150)
    if (isOnPage(key)) {
      await wait(900) // 页面内异步数据（列表/日志）落定
      return true
    }
  }
  return false
}

const visited = []
const rounds = []
rounds.push({ ...sweep(currentPageLabel(), 'dark'), key: 'console' })
rounds.push({ ...sweep(currentPageLabel(), 'light'), key: 'console' })
visited.push('console')
for (const key of PAGES) {
  if (key === 'console') continue
  if (!(await gotoTab(key))) {
    visited.push(`MISS:${key}`)
    continue
  }
  visited.push(key)
  rounds.push({ ...sweep(currentPageLabel(), 'dark'), key })
  rounds.push({ ...sweep(currentPageLabel(), 'light'), key })
}

const all = rounds.flatMap((r) => r.entries)
const failures = all.filter((e) => e.ratio < e.threshold)
// 覆盖自证：实际访问到的页面 key 列表，必须 9 个互不相同（否则就是又一次假达标）
const distinctVisited = Array.from(new Set(visited.filter((v) => !String(v).startsWith('MISS:'))))
return {
  coverage: {
    requested: PAGES,
    visited,
    distinctVisited,
    distinctCount: distinctVisited.length,
    complete9: distinctVisited.length === PAGES.length && visited.every((v) => !String(v).startsWith('MISS:')),
  },
  rounds: rounds.map((r) => ({ key: r.key, page: r.page, theme: r.theme, scanned: r.scanned, distinct: r.entries.length })),
  distinctTextStyles: all.length,
  failures: failures.length,
  failList: failures
    .sort((a, b) => a.ratio - b.ratio)
    .map((f) => ({ page: f.page, theme: f.theme, sel: f.sel, sample: f.sample, ratio: f.ratio, threshold: f.threshold, fg: f.fg, bg: f.bg, fontPx: f.fontPx, count: f.count })),
}
