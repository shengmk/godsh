/**
 * 分部 G 浏览器断言载荷：验证 dsh 设置页里的**沙箱面板真的渲染出来了**。
 *
 * ⚠️ 载荷格式：`probe-browser.mjs` 把它包成 `(async () => { <本文件> })()` 并 await，
 * 因此本文件是一段**语句体**，必须用顶层 `return` 交回结果（写成 IIFE 会得到 `undefined`）。
 *
 * 判据分两层，缺一不可：
 *  1. **面板本身**：设置页侧栏出现本插件的 section 标签；
 *  2. **面板内容**：正文里出现沙箱面板特有的控件文案（数据目录 / 注入并热装载 / 收割环境 等）。
 *     只看到 section 标签只能证明"注册成功"，证明不了"面板渲染出了内容"。
 *
 * 用法：
 *   node scripts/probe-browser.mjs --url "<dsh 实例地址>" --js scripts/audits/godsh-sandbox-probe.mjs --wait body --timeout 120000
 */

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 等应用完成装载（dsh web 是边加载插件边渲染的，--wait body 保证不了插件装载完成）。 */
const bootDeadline = Date.now() + 30000
let booted = false
while (Date.now() < bootDeadline) {
  const text = document.body?.innerText ?? ''
  if (text.length > 120 || /godsh|设置|Settings/i.test(text)) {
    booted = true
    break
  }
  await new Promise((r) => setTimeout(r, 500))
}

/** 面板内容的判据词：命中任意两个以上才认为"面板真的渲染了内容"。 */
const CONTENT_MARKERS = ['数据目录', '注入并热装载', '收割环境', '回收空间', '检查更新', '目标环境', '当前运行环境', '已注入环境']

const scan = () => {
  const text = document.body?.innerText ?? ''
  return {
    chars: text.length,
    hasSectionLabel: text.includes('godsh 插件沙箱'),
    contentHits: CONTENT_MARKERS.filter((m) => text.includes(m)),
    /** 目标包名是否出现在列表里（注入过之后应当能看到）。 */
    hasRow: text.includes(window.__GODSH_PROBE_PKG__ ?? '@@none@@'),
  }
}

// 首屏若没有面板内容，点开「设置」再看一次（按可见文本匹配，不硬编码 dsh 的选择器）
let clicked = null
let clickedSection = null
const before = scan()
if (before.contentHits.length < 2) {
  const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
  const settings = candidates.find((el) => {
    const t = `${norm(el.textContent)} ${norm(el.getAttribute('aria-label'))} ${norm(el.getAttribute('title'))}`
    return /设置|settings/i.test(t)
  })
  if (settings) {
    clicked = norm(`${settings.textContent} ${settings.getAttribute('aria-label')}`).slice(0, 40)
    settings.click()
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// dsh 的设置页一次只显示**一个** section：进了设置页还不够，必须再点进本插件那一节。
// 少了这一步，断言只会看到"侧栏里有标签"，而看不到面板内容 —— 那证明不了面板能渲染。
const mid = scan()
if (mid.contentHits.length < 2) {
  const all = [...document.querySelectorAll('button, a, li, [role="tab"], [role="button"], div, span')]
  const target = all.find((el) => norm(el.textContent) === 'godsh 插件沙箱')
  if (target) {
    // 文本节点本身可能不可点，向上找最近的"看起来可点"的祖先
    let node = target
    for (let i = 0; i < 4 && node.parentElement; i++) {
      const cls = String(node.className ?? '')
      const role = node.getAttribute?.('role') ?? ''
      if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.tagName === 'LI' || role !== '' || /tab|item|nav/i.test(cls)) break
      node = node.parentElement
    }
    clickedSection = norm(node.textContent).slice(0, 40)
    node.click()
    await new Promise((r) => setTimeout(r, 3500))
  }
}

const after = scan()

return {
  booted,
  clicked,
  clickedSection,
  sectionLabelFound: after.hasSectionLabel || before.hasSectionLabel,
  contentHits: after.contentHits.length > 0 ? after.contentHits : mid.contentHits,
  contentHitCount: Math.max(after.contentHits.length, mid.contentHits.length),
  rowFound: after.hasRow || mid.hasRow,
  bodyChars: after.chars,
  bodySample: (document.body?.innerText ?? '').slice(0, 700),
}
