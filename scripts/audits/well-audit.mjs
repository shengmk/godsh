#!/usr/bin/env node
/**
 * 暗井（Dark Well）逐文本节点对比度审计 —— godsh 分部 A 的证据基础。
 *
 * 为什么必须新写一个：既有的 contrast-sweep / contrast-targeted 是**按元素**采样（只测「自己带文字的元素」），
 * 且把「元素自身 + 祖先链」的纯色/渐变色标合成成候选背景后取最差值 —— 这套方法在「暗井」这一情形上会失效：
 * 暗井容器（`.terminal-window` / `.log-viewer` / `.fault-details` / …）自身把 `color` 与 `background`
 * 一起改掉了，于是**容器内部**任何在后代上显式声明过颜色的节点，其前景/背景配对在整个页面上都找不到同类样本，
 * 按「(前景色, 最坏背景色, 字号档) 去重」的旧口径会被独立成一条，却因为背景求解停在页面级底色上而判为达标。
 * 结果就是历史审计报「20 条不达标 → 0」，而用户仍然看见不可读文字（J-Space 不变量 2：审计跑过却什么都没发现）。
 *
 * 本审计的口径（逐条对应分部 A 的硬要求）：
 *  1) **逐文本节点**：用 TreeWalker 取 `body` 下每一个非空白文本节点（不是"自己带文字的元素"），
 *     对每个节点求解其**实际生效背景** —— 从它的父元素沿祖先链上溯，边合成半透明层边前进，
 *     直到遇到**第一个不透明背景**为止；再与该节点的 `color` 算 WCAG 对比度。
 *  2) **无法求解就如实标注**：祖先链上出现 `url(...)` 位图背景时，标注 `unsolvable` 并按「未判定」单独统计，
 *     **绝不算作通过**；出现渐变时按各色标逐个合成、取最坏值，并打上 `gradient-composited(approx)` 标记进
 *     `approximations` 列表（这是"如实标注"而非"当成通过"：报告里能一眼看到哪些结论是近似的）。
 *  3) **阳性对照**：页面里注入两个对比度**已知必然不达标**的探针（页面级 + 暗井内各一）。
 *     审计必须把它们报出来，否则 `controlDetected=false`，整份结果作废（这是防止"跑过但什么都没发现"的唯一手段）。
 *  4) 打印 `visited` 与 `distinctCount` 自证覆盖；并单独统计「实际观察到暗井元素的页面」，与源码事实比对。
 *
 * 用法（Node 侧驱动；无头浏览器启动与页面遍历复用 scripts/probe-browser.mjs，不另起一套）：
 *   node scripts/audits/well-audit.mjs --theme light --url http://127.0.0.1:4790/ --width 1440 --height 900
 *   node scripts/audits/well-audit.mjs --theme dark  --out .tmp/well-audit-dark.json
 *   node scripts/audits/well-audit.mjs --theme none
 *
 * 退出码：0 = 0 违规且对照检出且 9 页覆盖完整；1 = 有违规；3 = 阳性对照未检出（结果无效）；10 = 参数/流程错。
 *
 * 本文件是一个**双面**脚本：Node 侧是驱动（下面的 `main`），浏览器侧是 payload（下面的 `wellAuditPayload`）。
 * 驱动把自己的 `wellAuditPayload` 函数源码抽出来、拼上一行主题常量写成临时 payload，交给 probe-browser 注入执行。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = resolve(HERE, '..', 'probe-browser.mjs')

const USAGE = `用法: node scripts/audits/well-audit.mjs [--theme light|dark|none] [--url <url>] [--width 1440] [--height 900] [--timeout 120000] [--out <file>]`

function parseArgs(argv) {
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
  }
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const theme = opt('theme', 'light')
  if (!['light', 'dark', 'none'].includes(theme)) return { error: `--theme 只接受 light|dark|none，收到 ${theme}` }
  return {
    theme,
    url: opt('url', 'http://127.0.0.1:4790/'),
    width: Number(opt('width', '1440')),
    height: Number(opt('height', '900')),
    timeout: Number(opt('timeout', '120000')),
    out: opt('out', ''),
  }
}

function main(opts) {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-well-audit-'))
  const payloadFile = join(tmp, 'payload.mjs')
  try {
    const payload = `const WELL_THEME = ${JSON.stringify(opts.theme)}\nreturn await (${wellAuditPayload.toString()})()\n`
    writeFileSync(payloadFile, payload, 'utf8')

    console.log(`[well-audit] theme=${opts.theme} url=${opts.url} viewport=${opts.width}x${opts.height}`)
    const r = spawnSync(
      process.execPath,
      [
        PROBE,
        '--url', opts.url,
        '--js', payloadFile,
        // 等待条件用 `[data-page-container]` 而不是 `body`：后端冷启动时 SPA 首次挂载实测要 40s 以上，
        // 只等 body 会让 payload 在 React 还没渲染时就开始跑，所有页面都会被误判为 MISS（本脚本实测踩过）。
        '--wait', '[data-page-container]',
        '--width', String(opts.width),
        '--height', String(opts.height),
        '--timeout', String(opts.timeout),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim())
    if (r.status !== 0 && !r.stdout) {
      console.error(`[well-audit] 探针失败（exit ${r.status}）`)
      return 10
    }

    let data
    try {
      data = JSON.parse(r.stdout)
    } catch (e) {
      console.error('[well-audit] 无法解析探针输出：', e.message)
      console.error(r.stdout?.slice(0, 4000))
      return 10
    }

    console.log(JSON.stringify(data, null, 2))
    if (opts.out) {
      writeFileSync(resolve(opts.out), JSON.stringify(data, null, 2), 'utf8')
      console.log(`[well-audit] 原始结果已写入 ${resolve(opts.out)}`)
    }

    const s = data.summary
    console.log(
      `[well-audit] 汇总: theme=${data.theme} visited=${data.coverage.distinctCount}/${data.coverage.requested.length}` +
        ` 文本节点=${s.textNodes} 违规=${s.violations} 无法求解=${s.unsolvable}` +
        ` controlDetected=${s.controlDetected} 暗井页=${data.coverage.wellPagesVisited.join(',') || '(无)'}`
    )
    if (!s.controlDetected) {
      console.error('[well-audit] 阳性对照未检出 → 本次审计结果无效，0 违规不构成任何证据')
      return 3
    }
    if (!data.coverage.complete9) {
      console.error(`[well-audit] 覆盖不完整：visited=${JSON.stringify(data.coverage.visited)}`)
      return 3
    }
    return s.violations > 0 ? 1 : 0
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed.help) {
  console.log(USAGE)
  process.exit(0)
}
if (parsed.error) {
  console.error(parsed.error)
  console.error(USAGE)
  process.exit(10)
}
if (typeof document === 'undefined') {
  // Node 侧：本文件是驱动。浏览器侧只会拿到下面 wellAuditPayload 的函数源码。
  process.exit(main(parsed))
}

/* ================================================================================================
   以下为**浏览器侧 payload**：由 main() 抽出函数源码后注入执行，不得引用任何 Node API / 外层变量
   （唯一允许的外部标识符是驱动拼进来的 `WELL_THEME`）。
   ================================================================================================ */
async function wellAuditPayload() {
  const THEME = WELL_THEME

  /* ---------------- 颜色与对比度 ---------------- */
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
  const round2 = (n) => Math.round(n * 100) / 100
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /* ---------------- 暗井类名清单 ----------------
     前 6 个来自 styles.css:411-422（历史补丁点），`.dark-well` 是分部 A 新增的**主题无关**井类，
     后 4 个是同一缺陷类在别处的实例（实测 grep：`.terminal-panel` 在 SystemTasksPage.tsx:268，
     `.log-panel` 在 DshEnvsPage.tsx:312 / KernelsPage.tsx:537 / ProfilesPage.tsx:1076，
     `.fault-card` 是 ErrorBoundary 的外层卡片，`.fault-details` 是它的错误码框）。 */
  const WELLS = [
    '.terminal-window',
    '.terminal-container',
    'pre.log-stream',
    '.log-viewer',
    '.console-terminal',
    '.fault-details',
    '.dark-well',
    '.terminal-panel',
    '.log-panel',
    '.fault-card',
  ]
  const WELL_SELECTOR = WELLS.join(',')
  /** 源码事实：这些页面存在暗井实例（用于与「实际观察到暗井的页面」比对，而不是靠猜）。 */
  const WELL_PAGES_EXPECTED = ['profiles', 'tasks', 'kernels', 'dsh-envs']

  /* ---------------- 页面清单与切换 ----------------
     页面切换按 hash 路由 key，不看导航文案（既有三个审计脚本都因为按文案反查而只走到 5 页，
     教训写在 contrast-sweep.mjs:149-156 的注释里）。到位判定看 KeepAlive 的
     `[data-page-container=key]` 是否可见，这样切换语言也不会让覆盖面静默缩水。 */
  const PAGES = ['console', 'profiles', 'tasks', 'market', 'vault', 'allocations', 'kernels', 'dsh-envs', 'settings']
  const isOnPage = (key) => {
    const box = document.querySelector(`[data-page-container="${key}"]`)
    return !!box && box.style.display !== 'none'
  }
  const pageLabel = () => (document.querySelector('.nav-item.active')?.textContent ?? 'current').trim().slice(0, 14)
  const activeContainer = () => document.querySelector('[data-page-container]:not([style*="display: none"])')

  async function gotoTab(key) {
    if (location.hash.replace(/^#\/?/, '') !== key) location.hash = `#/${key}`
    // 每页最多等 20s：懒惰加载的页面 chunk + 页面内异步数据落定。
    // （实测 SystemTasksPage 首次挂载在冷启动后端上要十几秒；6s 的旧预算会把到位的页面误判为 MISS。）
    for (let i = 0; i < 100; i++) {
      await wait(200)
      if (isOnPage(key)) {
        await wait(1000) // 页面内异步数据（列表/日志）落定
        return true
      }
    }
    return false
  }

  /* ---------------- 阳性对照与同构复现探针 ----------------
     ① control-plain     页面级对照：白底上写近白字（约 1.0:1）—— 必须被检出，否则审计无效。
     ② control-in-well   井内对照：暗井容器里写深色字 —— 必须被检出，证明"井内每个文本节点都真的被测了"，
                          而不是只测了井容器自身的 `color`。
     ③ repro-well-<sel>  同构复现：把井容器**真实后代**（badge / mono-tag / card-title / table th·td /
                          fault-code / fault-desc）逐一塞进每一个井类名里。这不是"自然导航到达的状态"，
                          而是**用真实标记 + 真实样式表**对同一 CSS 缺陷做的定向复现；报告里单列
                          `injectedRepro` 一节，绝不与自然结论混在一起。 */
  const PROBE_ATTR = 'data-well-audit-probe'
  const REPRO_WELLS = WELLS
  const WELL_INNER = `<span class="badge">徽章 badge</span> <span class="mono-tag">等宽 mono-tag</span>` +
    `<div class="card-title">卡片标题 card-title</div>` +
    `<table class="table"><thead><tr><th>表头 th</th></tr></thead><tbody><tr><td>单元格 td</td></tr></tbody></table>` +
    `<div class="fault-details"><code class="fault-code">故障码 fault-code</code></div>` +
    `<p class="fault-desc">故障说明 fault-desc</p>`

  function installProbes() {
    const host = document.createElement('div')
    host.setAttribute(PROBE_ATTR, 'host')
    host.setAttribute('data-well-audit-host', '1')
    host.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483000;width:660px;display:flex;flex-direction:column;' +
      'gap:4px;background:transparent;pointer-events:none;overflow:hidden;'

    const plain = document.createElement('div')
    plain.setAttribute(PROBE_ATTR, 'control-plain')
    plain.style.cssText = 'background:#ffffff;color:#fdfdfd;font-size:14px;width:220px;height:18px;line-height:18px;'
    plain.textContent = '对照探针-页面级'

    const wellBox = document.createElement('div')
    wellBox.className = 'terminal-window'
    wellBox.setAttribute(PROBE_ATTR, 'control-in-well')
    wellBox.style.cssText = 'width:220px;min-height:22px;padding:2px 6px;'
    const wellText = document.createElement('span')
    wellText.style.cssText = 'color:#111827;font-size:13px;'
    wellText.textContent = '对照探针-井内'
    wellBox.appendChild(wellText)

    host.append(plain, wellBox)
    for (const sel of REPRO_WELLS) {
      const box = document.createElement(sel.startsWith('pre') ? 'pre' : 'div')
      box.className = sel.startsWith('pre') ? sel.slice(4) : sel.slice(1)
      box.setAttribute(PROBE_ATTR, `repro-well:${sel}`)
      box.style.cssText = 'width:620px;min-height:24px;padding:6px;'
      box.innerHTML = WELL_INNER
      host.appendChild(box)
    }
    document.body.appendChild(host)
    return host
  }
  function removeProbes(host) {
    try {
      host?.remove()
    } catch {}
  }

  /* ---------------- 生效背景求解 ---------------- */
  let csCache = new Map()
  const csOf = (el) => {
    let cs = csCache.get(el)
    if (!cs) {
      cs = getComputedStyle(el)
      csCache.set(el, cs)
    }
    return cs
  }
  const gradientStops = (image) => {
    const out = []
    for (const m of String(image).matchAll(/rgba?\([^)]+\)/gi)) {
      const c = parseColor(m[0])
      if (c && c.a > 0) out.push(c)
    }
    return out
  }
  const SEL = (el) => {
    if (!el || el.nodeType !== 1) return '#text'
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    const id = el.id ? `#${el.id}` : ''
    return el.tagName.toLowerCase() + id + (cls.length ? '.' + cls.join('.') : '')
  }
  const pathOf = (el) => {
    const parts = []
    let n = el
    let guard = 0
    while (n && n.nodeType === 1 && guard++ < 6) {
      parts.unshift(SEL(n))
      if (n === document.body) break
      n = n.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * 求解某元素背后的**实际生效背景**。
   * 返回 { candidates, unsolvable, urlLayers, gradient, baseFrom, opaqueFound }。
   * - candidates：所有可能的背景色（渐变各色标 → 多个候选）。取「与前景对比度最差」的那个即最坏情形。
   * - unsolvable：祖先链上出现 `url(...)` 位图 → 无法求解，**不算通过**。
   * - gradient：结果里合成过渐变色标 → 结论是近似的，记入 approximations。
   */
  function resolveBackground(el) {
    const layers = []
    let node = el
    let opaque = null
    while (node && node.nodeType === 1) {
      const cs = csOf(node)
      const bg = parseColor(cs.backgroundColor)
      const bi = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : ''
      const isUrl = bi ? /url\(/i.test(bi) : false
      layers.push({ node, bg, isUrl, stops: bi && !isUrl ? gradientStops(bi) : [] })
      if (bg && bg.a === 1) {
        opaque = bg
        break
      }
      node = node.parentElement
    }

    let base = { r: 255, g: 255, b: 255, a: 1 }
    let baseFrom = 'fallback-white'
    if (opaque) {
      base = opaque
      baseFrom = 'opaque-ancestor'
    } else {
      const bodyBg = parseColor(csOf(document.body).backgroundColor)
      const htmlBg = parseColor(csOf(document.documentElement).backgroundColor)
      if (bodyBg && bodyBg.a === 1) {
        base = bodyBg
        baseFrom = 'body'
      } else if (htmlBg && htmlBg.a === 1) {
        base = htmlBg
        baseFrom = 'html'
      } else {
        baseFrom = 'unresolved-fallback-white'
      }
    }

    const urlLayers = []
    const gradientNodes = []
    let candidates = [base]
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i]
      if (L.isUrl) urlLayers.push(SEL(L.node))
      const next = []
      for (const c of candidates) {
        const bgc = L.bg && L.bg.a > 0 ? over(L.bg, c) : c
        if (L.stops.length) {
          gradientNodes.push(L.node)
          for (const s of L.stops) next.push(over(s, bgc))
        } else {
          next.push(bgc)
        }
      }
      candidates = next.length ? next : candidates
    }
    return {
      candidates,
      unsolvable: urlLayers.length > 0,
      urlLayers,
      gradientNodes,
      baseFrom,
      opaqueFound: Boolean(opaque),
    }
  }

  const invisibleReason = (el, rect) => {
    if (!rect || rect.width < 2 || rect.height < 2) return 'zero-size'
    let n = el
    let guard = 0
    while (n && n.nodeType === 1 && guard++ < 40) {
      const cs = csOf(n)
      if (cs.display === 'none') return 'display-none'
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility-hidden'
      if (Number(cs.opacity) < 0.5) return 'opacity<0.5'
      n = n.parentElement
    }
    return null
  }

  /** 文本节点自身的可见矩形（用 Range，能正确处理行内节点）。 */
  const textRect = (node) => {
    try {
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = range.getClientRects()
      if (!rects.length) return null
      let best = rects[0]
      for (const r of rects) if (r.width * r.height > best.width * best.height) best = r
      return best
    } catch {
      return null
    }
  }

  /* ---------------- 单页扫描 ---------------- */
  function sweep(pageKey, theme) {
    const root = document.documentElement
    if (theme === 'none') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    // 主题切换必须强制一次样式重算 + 布局，否则 getComputedStyle / getClientRects 可能拿到上一主题的值
    csCache = new Map()
    void document.body.offsetHeight

    const out = { page: pageKey, label: pageLabel(), theme, textNodes: 0, skipped: 0, unsolvable: 0, gradient: 0, bodyGradient: 0 }
    const seen = new Map()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const raw = node.textContent ?? ''
      if (!raw.trim()) continue
      const el = node.parentElement
      if (!el) continue
      const rect = textRect(node)
      const bad = invisibleReason(el, rect)
      if (bad) {
        out.skipped++
        continue
      }
      const cs = csOf(el)
      const fontPx = parseFloat(cs.fontSize)
      if (!(fontPx >= 10)) {
        out.skipped++
        continue
      }
      const fg = parseColor(cs.color)
      if (!fg) {
        out.skipped++
        continue
      }
      out.textNodes++

      // 渐变文字（background-clip:text）：真正的字色是渐变，不是被置空的 computed color
      const clip = cs.webkitBackgroundClip || cs.getPropertyValue('-webkit-background-clip')
      const fill = cs.webkitTextFillColor ?? cs.getPropertyValue('-webkit-text-fill-color')
      const fillC = parseColor(fill)
      const isGradientText = clip === 'text' && cs.backgroundImage !== 'none' && (!fillC || fillC.a === 0)
      const bgOwner = isGradientText ? el.parentElement ?? el : el
      const bg = resolveBackground(bgOwner)
      const fgs = isGradientText ? gradientStops(cs.backgroundImage) : [fg]
      if (!fgs.length) fgs.push(fg)

      let worst = Infinity
      let worstBg = bg.candidates[0]
      for (const c of bg.candidates) {
        for (const f of fgs) {
          const fgOn = f.a < 1 ? over(f, c) : f
          const r = contrast(fgOn, c)
          if (r < worst) {
            worst = r
            worstBg = c
          }
        }
      }

      const bold = parseInt(cs.fontWeight, 10) >= 700
      const large = fontPx >= 24 || (fontPx >= 18.66 && bold)
      const threshold = large ? 3.0 : 4.5

      const probes = []
      let p = el
      let guard = 0
      while (p && p.nodeType === 1 && guard++ < 12) {
        if (p.hasAttribute(PROBE_ATTR)) {
          probes.push(p.getAttribute(PROBE_ATTR))
          break
        }
        p = p.parentElement
      }
      const wells = []
      let w = el
      let wGuard = 0
      while (w && w.nodeType === 1 && wGuard++ < 40) {
        for (const sel of WELLS) if (w.matches && w.matches(sel)) wells.push(sel)
        w = w.parentElement
      }

      if (bg.unsolvable) out.unsolvable++
      // 背景里合成过渐变 → 结论是近似值。但要区分「body/html 上的装饰性环境渐变」（几乎每个节点都命中，
      // 逐条列出只会淹没报告）与「更深元素上的实体渐变」（可能真的决定可读性）。前者计入计数并在
      // bgMethod 上标注，后者才进 approximations 明细。
      const materialGradient = bg.gradientNodes.some((n) => n !== document.body && n !== document.documentElement)
      if (bg.gradientNodes.length) {
        if (materialGradient) out.gradient++
        else out.bodyGradient++
      }

      const rec = {
        page: pageKey,
        label: out.label,
        theme,
        path: pathOf(el),
        sample: raw.trim().slice(0, 24),
        fg: isGradientText ? `${rgbStr(fgs[0])} (渐变文字最差色标)` : cs.color,
        bg: rgbStr(worstBg),
        ratio: round2(worst),
        threshold,
        fontPx: Math.round(fontPx * 10) / 10,
        bold,
        well: wells[0] ?? null,
        wellChain: wells,
        probe: probes[0] ?? null,
        bgMethod: bg.unsolvable
          ? `unsolvable:url(${bg.urlLayers.join(',')})`
          : materialGradient
            ? 'gradient-composited(approx)'
            : bg.gradientNodes.length
              ? 'body-gradient-composited(approx)'
              : 'solid',
        bgBase: bg.baseFrom,
      }
      const key = [
        pageKey, theme, rec.path, rec.fg, rec.bg, rec.fontPx, rec.bold, rec.well, rec.probe, rec.bgMethod,
      ].join('|')
      const hit = seen.get(key)
      if (hit) hit.count++
      else seen.set(key, { ...rec, count: 1 })
    }
    out.entries = Array.from(seen.values())
    return out
  }

  /* ---------------- 暗井元素盘点 + 尽力揭示被折叠的暗井 ---------------- */
  const visibleWells = () => {
    const out = []
    for (const sel of WELLS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest(`[${PROBE_ATTR}]`)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        if (invisibleReason(el, r)) continue
        out.push({ sel, path: pathOf(el), w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
    return out
  }
  /**
   * 尽力让被折叠的暗井显形：点页面里文案恰为「日志」的按钮（ProfilesPage.tsx:1040、KernelsPage.tsx:510）。
   * 只点这一个文案，不做模糊匹配 —— 模糊匹配会误点「查看日志」「收起日志」等，把状态搅乱。
   * 返回诊断信息：找到几个「日志」按钮、其中几个是禁用的、点了几个。
   * 为什么要有诊断：`kernels` 页的 `.log-panel` 需要 kernel 实例**且**该实例有 profile/port
   * （KernelsPage.tsx:509 的 disabled 条件），`dsh-envs` 页的 `.log-panel` 需要存在历史任务
   * （DshEnvsPage.tsx 的 `latestTask` 门控）。只读审计既不能启动内核也不能跑任务，这两页的暗井
   * 可能**天然不存在**；报告必须说清楚是「没找到」还是「不存在」，不能让覆盖面静默缩水。
   */
  async function revealWells() {
    const diag = { logButtons: 0, disabledLogButtons: 0, clicked: 0 }
    for (let round = 0; round < 2; round++) {
      if (visibleWells().length) return diag
      const scope = activeContainer() ?? document
      const all = Array.from(scope.querySelectorAll('button')).filter((b) => (b.textContent ?? '').trim() === '日志')
      const usable = all.filter((b) => !b.disabled && b.getBoundingClientRect().width > 2)
      diag.logButtons = Math.max(diag.logButtons, all.length)
      diag.disabledLogButtons = Math.max(diag.disabledLogButtons, all.length - usable.length)
      if (!usable.length) return diag
      for (const b of usable.slice(0, 2)) {
        b.click()
        diag.clicked++
        await wait(700)
        if (visibleWells().length) return diag
      }
    }
    return diag
  }

  /* ---------------- 主流程 ---------------- */
  const kill = document.createElement('style')
  kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
  document.head.appendChild(kill)

  const probeHost = installProbes()
  await wait(120)

  const visited = []
  const distinctVisited = []
  const rounds = []
  const naturalViolations = []
  const unsolvableNodes = []
  const approximations = []
  const probeEntries = []
  const wellPagesVisited = []
  const wellsSeen = []

  const record = (key) => {
    visited.push(THEME === 'none' ? key : `${THEME}:${key}`)
    if (!distinctVisited.includes(key)) distinctVisited.push(key)
  }

  async function run(key) {
    record(key)
    const reveal = await revealWells()
    const wells = visibleWells()
    const r = sweep(key, THEME)
    rounds.push({
      key,
      label: r.label,
      theme: r.theme,
      textNodes: r.textNodes,
      skipped: r.skipped,
      distinct: r.entries.length,
      violations: r.entries.filter((e) => !e.probe && e.ratio < e.threshold).length,
      unsolvable: r.unsolvable,
      gradient: r.gradient,
      bodyGradient: r.bodyGradient,
      wells: wells.map((x) => `${x.sel}(${x.w}x${x.h})`),
      reveal,
    })
    if (wells.length) {
      wellPagesVisited.push(key)
      wellsSeen.push({ page: key, wells })
    }
    for (const e of r.entries) {
      if (e.probe) {
        probeEntries.push(e)
        continue
      }
      if (e.bgMethod.startsWith('unsolvable:')) {
        unsolvableNodes.push(e)
        continue
      }
      if (e.bgMethod.startsWith('gradient')) approximations.push(e)
      if (e.ratio < e.threshold) naturalViolations.push(e)
    }
  }

  await run('console')
  for (const key of PAGES) {
    if (key === 'console') continue
    if (!(await gotoTab(key))) {
      visited.push(`MISS:${key}`)
      continue
    }
    await run(key)
  }

  // 探针必须活在每一页的扫描里，全部扫完再撤
  removeProbes(probeHost)

  const dedupe = (list) => {
    const m = new Map()
    for (const e of list) {
      const k = [e.page, e.path, e.fg, e.bg, e.well, e.probe, e.bgMethod].join('|')
      const hit = m.get(k)
      if (hit) hit.count += e.count
      else m.set(k, { ...e })
    }
    return Array.from(m.values())
  }
  const sortWorst = (a, b) => a.ratio - b.ratio

  const controlHits = {}
  for (const e of probeEntries) {
    const ok = e.ratio < e.threshold
    const k = ok ? e.probe : `${e.probe}#passed`
    controlHits[k] = (controlHits[k] ?? 0) + 1
  }
  const controlDetected = (controlHits['control-plain'] ?? 0) > 0 && (controlHits['control-in-well'] ?? 0) > 0

  const reproEntries = probeEntries.filter((e) => e.probe.startsWith('repro-well:'))
  const violations = dedupe(naturalViolations).sort(sortWorst)
  const wellInteriorViolations = violations.filter((e) => e.well)
  const repro = dedupe(reproEntries.filter((e) => e.ratio < e.threshold)).sort(sortWorst)
  const reproClean = dedupe(reproEntries.filter((e) => e.ratio >= e.threshold)).sort(sortWorst)
  const unsolv = dedupe(unsolvableNodes).sort(sortWorst)
  const approxOutsideProbe = dedupe(approximations).sort(sortWorst)

  const wellPagesMissing = WELL_PAGES_EXPECTED.filter((k) => !rounds.some((r) => r.key === k && r.wells.length))

  return {
    theme: THEME,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight },
    coverage: {
      requested: PAGES,
      visited,
      distinctVisited,
      distinctCount: distinctVisited.length,
      complete9: distinctVisited.length === PAGES.length && !visited.some((v) => String(v).startsWith('MISS:')),
      wellPagesExpected: WELL_PAGES_EXPECTED,
      wellPagesVisited,
      wellPagesMissing,
      wellsSeen,
      wellPagesNote:
        'wellPagesVisited 只统计**自然渲染出来**的暗井元素。kernels / dsh-envs 的 `.log-panel` 分别被 ' +
        'KernelsPage.tsx:509 的 disabled 条件与 DshEnvsPage 的 latestTask 门控，只读审计不能启动内核/跑任务，' +
        '因此这两页的暗井可能天然不存在（每页 rounds[].reveal 记了「找到几个日志按钮、几个禁用」以便区分' +
        '「没找到」与「不存在」）。注意：注入的同构复现探针是 position:fixed 的，**在全部 9 页上都被测过**，' +
        '所以「暗井类名的 CSS 在每一页的结果」都有覆盖，缺的只是那两页的自然实例。',
    },
    rounds,
    controls: {
      controlDetected,
      detail: controlHits,
      note:
        'control-plain（页面级白底近白字）与 control-in-well（暗井内深色字）是两个对比度已知必然不达标的注入探针；' +
        '两者都必须被检出，否则整份审计无效（防止"跑过却什么都没发现"）。',
    },
    summary: {
      textNodes: rounds.reduce((n, r) => n + r.textNodes, 0),
      violations: violations.length,
      wellInteriorViolations: wellInteriorViolations.length,
      unsolvable: unsolv.length,
      materialGradientApprox: approxOutsideProbe.length,
      bodyDecorativeGradientNodes: rounds.reduce((n, r) => n + r.bodyGradient, 0),
      injectedReproViolations: repro.length,
      controlDetected,
    },
    violations,
    wellInteriorViolations,
    unsolvable: unsolv,
    approximations: approxOutsideProbe,
    injectedRepro: {
      note:
        '以下**不是自然导航到达的状态**，而是把井容器的真实后代标记（badge / mono-tag / card-title / table th·td / fault-code / fault-desc）' +
        '注入到每一个井类名里，用同一份样式表测得的定向复现。它证明的是「这些后代落在暗井里会翻车」这一 CSS 事实，' +
        '不能替代「用户在哪一页看见它」的自然状态证据。',
      violations: repro,
      clean: reproClean,
    },
  }
}
