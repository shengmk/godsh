/**
 * F3 浏览器断言 payload：验证 `@godsh/dsh` 的浏览器半**真的把设置页注册出来了**。
 *
 * ⚠️ 载荷格式：`probe-browser.mjs` 会把它包成 `(async () => { <本文件> })()` 并 await，
 * 因此本文件是一段**语句体**，必须用顶层 `return` 交回结果 —— 写成 IIFE 会得到 `undefined`
 * （首版就是这么错的：`;(async () => {...})()` 在语句体里谁也不接它的返回值）。
 *
 * 它做两件事：
 *  1. 收集真实渲染页面里的可点击控件（文本 / aria-label / title）—— 用来**定位**"设置"入口，
 *     而不是硬编码 dsh 的 UI 选择器（猜错会得到一个假的"没找到"）。
 *  2. 报告页面里是否出现 godsh 面板的特征文本；首屏没有就按文本匹配点开设置类入口再看一次。
 */

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * 等应用完成装载。
 *
 * 首版直接扫，得到的是 `Loading plugins…`（body 只有 24 字）—— dsh web 是**边加载插件边渲染**的，
 * `--wait body` 只能保证 body 存在，保证不了插件装载完成。这里的判据是「body 文本明显变长
 * 或出现目标标记」，最多等 30 秒；超时就如实把当前文本带回去，不假装成功。
 */
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

const collect = () => {
  const out = []
  const seen = new Set()
  const nodes = document.querySelectorAll('button, a, [role="button"], [role="tab"], [aria-label]')
  for (const el of nodes) {
    const text = norm(el.textContent).slice(0, 40)
    const label = norm(el.getAttribute('aria-label')).slice(0, 40)
    const title = norm(el.getAttribute('title')).slice(0, 40)
    const key = `${text}|${label}|${title}`
    if (key === '||' || seen.has(key)) continue
    seen.add(key)
    const r = el.getBoundingClientRect()
    out.push({ text, label, title, visible: r.width > 0 && r.height > 0 })
    if (out.length >= 140) break
  }
  return out
}

const MARKERS = ['godsh 插件沙箱', 'godsh · 热装载桥', '热装载桥']
const scan = () => {
  const text = document.body.innerText || ''
  return { hits: MARKERS.filter((m) => text.includes(m)), chars: text.length }
}

const before = scan()
let clicked = null

if (before.hits.length === 0) {
  const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
  const settings = candidates.find((el) => {
    const t = `${norm(el.textContent)} ${norm(el.getAttribute('aria-label'))} ${norm(el.getAttribute('title'))}`
    return /设置|settings/i.test(t)
  })
  if (settings) {
    clicked = norm(`${settings.textContent} ${settings.getAttribute('aria-label')}`).slice(0, 40)
    settings.click()
    await new Promise((r) => setTimeout(r, 2500))
  }
}

const after = scan()

return {
  clickables: collect(),
  clicked,
  booted,
  hasGodshText: before.hits.length > 0 || after.hits.length > 0,
  hitsBefore: before.hits,
  hitsAfter: after.hits,
  bodyChars: after.chars,
  bodySample: (document.body?.innerText ?? '').slice(0, 400),
}
