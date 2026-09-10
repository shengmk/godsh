// 布局与字体审计：① 横向溢出（含元凶元素）② 长列表是否一次性渲染全部行 ③ 字体加载来源
// 视口由驱动脚本（scripts/probe-browser.mjs --width/--height）决定，页面内无法自行改变，
// 因此判定「不同分辨率下横向滚动为 0」需要在多个宽度下分别跑本 payload。

const round = (n) => Math.round(n * 10) / 10

function overflowReport() {
  const vw = document.documentElement.clientWidth
  const docOverflow = {
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: vw,
    horizontalScroll: document.documentElement.scrollWidth > vw + 1,
  }
  // 找元凶：右边界超出视口、且自身不承担横向滚动的可见元素
  const culprits = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const over = r.right - vw
    if (over > 1) {
      culprits.push({
        sel: el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase(),
        sample: (el.textContent ?? '').trim().slice(0, 20),
        right: round(r.right),
        overBy: round(over),
        scrollableItself: el.scrollWidth > el.clientWidth + 1,
        overflowX: cs.overflowX,
      })
    }
  }
  culprits.sort((a, b) => b.overBy - a.overBy)
  return { ...docOverflow, culpritCount: culprits.length, topCulprits: culprits.slice(0, 6) }
}

function longListReport() {
  // 常见容器：卡片网格与表格
  const candidates = [
    ['.plugin-grid', '插件卡片网格'],
    ['.vault-grid', '沙箱网格'],
    ['.alloc-grid', '分配网格'],
    ['.data-table tbody', '数据表行'],
    ['.profiles-grid', '环境卡片网格'],
    ['.card-grid', '通用卡片网格'],
  ]
  const out = []
  for (const [sel, label] of candidates) {
    for (const el of document.querySelectorAll(sel)) {
      const rows = el.children.length
      if (rows === 0) continue
      const rect = el.getBoundingClientRect()
      out.push({
        sel,
        label,
        rows,
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
        // 是否有虚拟化的迹象：滚动容器高度远大于可视高度但子节点很少
        looksVirtualized: el.scrollHeight > el.clientHeight * 3 && rows < 40,
        docNodes: document.querySelectorAll('*').length,
      })
      break
    }
  }
  return { containers: out, totalDomNodes: document.querySelectorAll('*').length }
}

function fontReport() {
  const families = new Set()
  for (const el of document.querySelectorAll('body, body *')) {
    const cs = getComputedStyle(el)
    families.add(cs.fontFamily.split(',')[0].replace(/["']/g, '').trim())
    if (families.size > 8) break
  }
  const fontResources = performance
    .getEntriesByType('resource')
    .filter((e) => /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(e.name) || /fonts\.(googleapis|gstatic)/i.test(e.name))
    .map((e) => ({ name: e.name.slice(0, 90), durationMs: Math.round(e.duration) }))
  const cssImports = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSImportRule) cssImports.push(rule.href)
      }
    } catch {}
  }
  let loadedFamilies = []
  try {
    loadedFamilies = Array.from(document.fonts).map((f) => `${f.family} ${f.weight} ${f.status}`)
  } catch {}
  return {
    usedFamilies: Array.from(families),
    cssImports,
    fontResources,
    loadedFaces: loadedFamilies.slice(0, 12),
    facesTotal: loadedFamilies.length,
  }
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
const record = (label) => pages.push({ page: label, overflow: overflowReport(), longList: longListReport() })
record(pageLabel())
for (const kw of ['环境', '沙箱', '分配', '市场', '任务', '设置', '内核', '控制台']) {
  if (await gotoTab(kw)) record(pageLabel())
}

return {
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  font: fontReport(),
  pages,
}
