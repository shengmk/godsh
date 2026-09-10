// 对比度审计 payload（渐变感知版）：在真实渲染的 godsh 页面里测量代表性文本的有效对比度。
//
// 两个关键点：
//  1) 半透明玻璃与装饰性渐变都要参与计算。做法是：先把祖先链上的**纯色**背景逐层合成得到基准背景，
//     再把祖先链上渐变里的每个非透明色标各自合成一次，取「与基准亮度差最大」的那个作为最坏情形；
//     最终报告 base 与 worst 两个对比度并取较小值（宁可低估也不高估）。
//  2) 首页没有表格/徽章，需要先点侧栏导航切到对应页面再测。

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

// 计算某元素「有效背景」的所有可能取值（候选集）。
//
// 为什么是集合而不是一个值：这一版设计里背景既可能是半透明玻璃，也可能是渐变。
// 逐层向上合成时，每一层如果是渐变，就有「多个可能底色」；只有把纯色与每个渐变色标
// 都当作候选合成下去，才能对最终对比度取**最坏值**。上一版只把祖先纯色当基准、
// 把元素自身的渐变只用于「最坏情形」，于是白字被拿去比白底，算出 1.01 这种荒唐值 ——
// 那是测量缺陷，不是产品缺陷。
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
    layers.push({ solid: hasSolid ? solid : null, stops, opaque: Boolean(hasSolid && solid.a === 1) })
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
      if (L.stops.length) {
        for (const s of L.stops) next.push(over(s, layerBase))
      } else {
        next.push(layerBase)
      }
    }
    candidates = next.length ? next : candidates
    // 注意：这里**不能**因为“遇到不透明层”就 break。
    // 合成是从下往上进行的，“下面无所谓了”由上面收集层时的那次 break 负责；
    // 若在这里 break，遇到 body 的不透明底色就会提前结束，元素自身的背景（如按钮的渐变）
    // 永远不会被应用 —— 上一版正是这样把白字拿去比浅色底，算出了 1.10 这种假失败。
  }
  return candidates
}

const SAMPLES = [
  ['body', '页面正文/底板文字', 4.5],
  ['.topbar', '顶栏区域', 3.0],
  ['.nav-item', '侧栏导航（未选中）', 4.5],
  ['.nav-item.active', '侧栏导航（选中）', 4.5],
  ['.brand-name', '侧栏标题', 4.5],
  ['.card', '卡片容器文字', 3.0],
  ['.card-title', '卡片标题', 4.5],
  ['.btn', '普通按钮', 4.5],
  ['.btn.primary', '主按钮', 4.5],
  ['.btn-secondary', '次按钮', 4.5],
  ['.search-input', '搜索输入占位', 3.0],
  ['.topbar-version', '顶栏版本号', 3.0],
  ['.data-table th', '表头', 4.5],
  ['.data-table td', '表格单元格', 4.5],
  ['.badge', '徽章', 4.5],
  ['.mono-tag', '等宽标签', 4.5],
  ['.plugin-name', '插件名', 4.5],
  ['.modal-content', '模态内容', 4.5],
]

const kill = document.createElement('style')
kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
document.head.appendChild(kill)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const navItems = () => Array.from(document.querySelectorAll('.nav-item'))

async function gotoTab(keyword) {
  const target = navItems().find((n) => (n.textContent ?? '').includes(keyword))
  if (!target) return false
  target.click()
  await wait(1200)
  return true
}

function measurePage(pageLabel, theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const out = []
  for (const [sel, label, threshold] of SAMPLES) {
    const el = document.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    const fg = parseColor(cs.color)
    if (!fg) continue
    const candidates = backgroundCandidates(el)
    const ratios = candidates.map((c) => {
      const fgOn = fg.a < 1 ? over(fg, c) : fg
      return contrast(fgOn, c)
    })
    const ratio = Math.min(...ratios)
    const ratioMax = Math.max(...ratios)
    const worstIdx = ratios.indexOf(ratio)
    out.push({
      page: pageLabel,
      theme,
      sel,
      label,
      ratio: Math.round(ratio * 100) / 100,
      ratioMax: Math.round(ratioMax * 100) / 100,
      candidates: candidates.length,
      threshold,
      pass: ratio >= threshold,
      fg: cs.color,
      bgWorst: rgbStr(candidates[worstIdx]),
      fontPx: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      bold: parseInt(cs.fontWeight, 10) >= 600,
      visible: el.getBoundingClientRect().width > 0,
    })
  }
  return out
}

const all = []
// 首页（默认落在哪页先看看），再依次切到有表格与徽章的页面
all.push(...measurePage(currentPageLabel(), 'dark'))
all.push(...measurePage(currentPageLabel(), 'light'))

function currentPageLabel() {
  const active = document.querySelector('.nav-item.active')
  return (active?.textContent ?? 'current').trim().slice(0, 12)
}

for (const kw of ['环境', '沙箱', '内核', '市场', '分配', '设置', '任务', '控制台']) {
  const ok = await gotoTab(kw)
  if (!ok) continue
  const label = currentPageLabel()
  all.push(...measurePage(label, 'dark'))
  all.push(...measurePage(label, 'light'))
}

const failures = all.filter((r) => !r.pass)
return {
  url: location.href,
  viewport: { w: innerWidth, h: innerHeight },
  sampled: all.length,
  failures: failures.length,
  failList: failures.map((f) => `${f.page}/${f.theme}/${f.sel} = ${f.ratio}（需 ${f.threshold}）`),
  results: all,
}
