// ① 找真实的长列表容器并统计一次性渲染的行数与 DOM 规模
// ② 实测字体是否真的可用：把同一段文字分别用「目标字族」与「确定的回退字族」渲染并比较宽度，
//    宽度不同说明目标字体真实生效，宽度相同说明发生了回退（比 document.fonts.check 更接近实际观感）。

const round = (n) => Math.round(n * 100) / 100

function rowCounts() {
  // 统计所有「有 >= 10 个同类子元素」的容器，按子元素数降序
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const kids = el.children.length
    if (kids < 10) continue
    const r = el.getBoundingClientRect()
    if (r.width < 50) continue
    const cs = getComputedStyle(el)
    const groups = new Map()
    for (const k of el.children) {
      const key = k.className && typeof k.className === 'string' ? k.className.trim().split(/\s+/)[0] : k.tagName.toLowerCase()
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    const top = Array.from(groups.entries()).sort((a, b) => b[1] - a[1])[0]
    out.push({
      sel: el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase(),
      children: kids,
      dominantChild: top?.[0],
      dominantCount: top?.[1],
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      overflowY: cs.overflowY,
    })
  }
  out.sort((a, b) => b.children - a.children)
  return { top: out.slice(0, 6), totalDomNodes: document.querySelectorAll('*').length }
}

function fontProbe() {
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;font-size:32px'
  document.body.appendChild(host)
  const text = 'MMMMmmmmiiiiWWWW 迁移沙箱内核 0123456789'
  const measure = (family) => {
    host.style.fontFamily = family
    host.textContent = text
    return round(host.getBoundingClientRect().width)
  }
  const results = []
  const cases = [
    ['Inter', 'sans-serif'],
    ['JetBrains Mono', 'monospace'],
    ['Geist Mono', 'monospace'],
  ]
  for (const [target, fallback] of cases) {
    const withTarget = measure(`"${target}", ${fallback}`)
    const withFallbackOnly = measure(fallback)
    const fallbackAlt = measure(fallback === 'monospace' ? 'Consolas, monospace' : 'Arial, sans-serif')
    results.push({
      target,
      fallback,
      widthWithTarget: withTarget,
      widthFallback: withFallbackOnly,
      widthFallbackAlt: fallbackAlt,
      // 与两种回退渲染宽度都不同 ⇒ 目标字体真实生效
      available: withTarget !== withFallbackOnly && withTarget !== fallbackAlt,
      checkApi: document.fonts.check(`32px "${target}"`),
    })
  }
  host.remove()
  // 页面里实际使用的字体栈（取首个非通用族）
  const stacks = new Set()
  for (const el of document.querySelectorAll('body, .card, .data-table td, .mono-tag, .page-title, .btn')) {
    stacks.add(getComputedStyle(el).fontFamily)
  }
  return { results, stacks: Array.from(stacks).slice(0, 6) }
}

const kill = document.createElement('style')
kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
document.head.appendChild(kill)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const navItems = () => Array.from(document.querySelectorAll('.nav-item'))
const pageLabel = () => (document.querySelector('.nav-item.active')?.textContent ?? 'current').trim().slice(0, 12)
async function gotoTab(kw) {
  const t = navItems().find((n) => (n.textContent ?? '').includes(kw))
  if (!t) return false
  t.click()
  await wait(1000)
  return true
}

const pages = []
const record = (label) => pages.push({ page: label, rows: rowCounts() })
record(pageLabel())
for (const kw of ['环境', '沙箱', '分配', '市场', '任务', '内核']) {
  if (await gotoTab(kw)) record(pageLabel())
}

return { viewport: { w: innerWidth, h: innerHeight }, font: fontProbe(), pages }
