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
  Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1)

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
    const cands = backgroundCandidates(el)
    let worst = Infinity
    let worstBg = null
    for (const c of cands) {
      const fgOn = fg.a < 1 ? over(fg, c) : fg
      const r = contrast(fgOn, c)
      if (r < worst) {
        worst = r
        worstBg = c
      }
    }
    const key = `${theme}|${cs.color}|${rgbStr(worstBg)}|${Math.round(fontPx)}|${bold}`
    const entry = seen.get(key) ?? {
      page: pageLabel,
      theme,
      sel: el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase(),
      sample: (el.textContent ?? '').trim().slice(0, 16),
      fg: cs.color,
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

const navItems = () => Array.from(document.querySelectorAll('.nav-item'))
const currentPageLabel = () => (document.querySelector('.nav-item.active')?.textContent ?? 'current').trim().slice(0, 14)
async function gotoTab(keyword) {
  const t = navItems().find((n) => (n.textContent ?? '').includes(keyword))
  if (!t) return false
  t.click()
  await wait(1200)
  return true
}

const rounds = []
rounds.push(sweep(currentPageLabel(), 'dark'))
rounds.push(sweep(currentPageLabel(), 'light'))
for (const kw of ['环境', '沙箱', '市场', '设置']) {
  if (!(await gotoTab(kw))) continue
  rounds.push(sweep(currentPageLabel(), 'dark'))
  rounds.push(sweep(currentPageLabel(), 'light'))
}

const all = rounds.flatMap((r) => r.entries)
const failures = all.filter((e) => e.ratio < e.threshold)
return {
  rounds: rounds.map((r) => ({ page: r.page, theme: r.theme, scanned: r.scanned, distinct: r.entries.length })),
  distinctTextStyles: all.length,
  failures: failures.length,
  failList: failures
    .sort((a, b) => a.ratio - b.ratio)
    .map((f) => ({ page: f.page, theme: f.theme, sel: f.sel, sample: f.sample, ratio: f.ratio, threshold: f.threshold, fg: f.fg, bg: f.bg, fontPx: f.fontPx, count: f.count })),
}
