#!/usr/bin/env node
/**
 * 主题回归抽样（分部 A 的「无回归」判据工具）。
 *
 * 目的：改样式前后，在**深色**与**无主题**两种状态下，把每一个可见文本节点的
 * computed `color` + `background-color` 逐节点 dump 出来，供两份 dump 直接 diff。
 * 只做"读值 + 落盘"，不做任何对比度计算 —— 结论由 diff 说话，不由脚本断言。
 *
 * 用法（与 well-audit.mjs 同一套驱动约定：复用 scripts/probe-browser.mjs 的无头浏览器启动与页面遍历）：
 *   node scripts/audits/theme-sample.mjs --theme dark --out %TEMP%\sample-dark-after.json
 *   node scripts/audits/theme-sample.mjs --theme none --out %TEMP%\sample-none-after.json
 *
 * 输出：{ theme, viewport, coverage:{visited,distinctCount,complete9}, nodes:[{page,path,color,bg,fontPx}] }
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = resolve(HERE, '..', 'probe-browser.mjs')

const USAGE =
  '用法: node scripts/audits/theme-sample.mjs [--theme dark|none|light] [--url <url>] [--width 1440] [--height 900] [--timeout 240000] [--out <file>]'

function parseArgs(argv) {
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
  }
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const theme = opt('theme', 'dark')
  if (!['light', 'dark', 'none'].includes(theme)) return { error: `--theme 只接受 light|dark|none，收到 ${theme}` }
  return {
    theme,
    url: opt('url', 'http://127.0.0.1:4790/'),
    width: Number(opt('width', '1440')),
    height: Number(opt('height', '900')),
    timeout: Number(opt('timeout', '240000')),
    out: opt('out', ''),
  }
}

function main(opts) {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-theme-sample-'))
  const payloadFile = join(tmp, 'payload.mjs')
  try {
    const payload = `const SAMPLE_THEME = ${JSON.stringify(opts.theme)}\nreturn await (${themeSamplePayload.toString()})()\n`
    writeFileSync(payloadFile, payload, 'utf8')
    console.log(`[theme-sample] theme=${opts.theme} url=${opts.url} viewport=${opts.width}x${opts.height}`)
    const r = spawnSync(
      process.execPath,
      [
        PROBE,
        '--url', opts.url,
        '--js', payloadFile,
        '--wait', '[data-page-container]',
        '--width', String(opts.width),
        '--height', String(opts.height),
        '--timeout', String(opts.timeout),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim())
    let data
    try {
      data = JSON.parse(r.stdout)
    } catch (e) {
      console.error('[theme-sample] 无法解析探针输出：', e.message)
      console.error(r.stdout?.slice(0, 2000))
      return 10
    }
    if (opts.out) {
      writeFileSync(resolve(opts.out), JSON.stringify(data, null, 2), 'utf8')
      console.log(`[theme-sample] theme=${data.theme} 节点=${data.nodes.length} 写入 ${resolve(opts.out)}`)
    } else {
      console.log(JSON.stringify(data, null, 2))
    }
    return data.coverage.complete9 ? 0 : 3
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
  process.exit(main(parsed))
}

/* ============ 浏览器侧 payload（唯一外部标识符：驱动拼进来的 SAMPLE_THEME） ============ */
async function themeSamplePayload() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const PAGES = ['console', 'profiles', 'tasks', 'market', 'vault', 'allocations', 'kernels', 'dsh-envs', 'settings']
  const isOnPage = (key) => {
    const box = document.querySelector(`[data-page-container="${key}"]`)
    return !!box && box.style.display !== 'none'
  }
  const SEL = (el) => {
    if (!el || el.nodeType !== 1) return '#text'
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '')
  }
  const pathOf = (el) => {
    const parts = []
    let n = el
    let g = 0
    while (n && n.nodeType === 1 && g++ < 6) {
      parts.unshift(SEL(n))
      if (n === document.body) break
      n = n.parentElement
    }
    return parts.join(' > ')
  }
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

  const kill = document.createElement('style')
  kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
  document.head.appendChild(kill)

  const visited = []
  const distinct = []
  const nodes = []

  function collect(pageKey) {
    for (const container of document.querySelectorAll('[data-page-container]')) {
      if (container.style.display === 'none') continue
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (!(node.textContent ?? '').trim()) continue
        const el = node.parentElement
        if (!el) continue
        const rect = textRect(node)
        if (!rect || rect.width < 2 || rect.height < 2) continue
        const cs = getComputedStyle(el)
        nodes.push({
          page: pageKey,
          path: pathOf(el),
          color: cs.color,
          bg: cs.backgroundColor,
          fontPx: Math.round(parseFloat(cs.fontSize) * 10) / 10,
          fontWeight: cs.fontWeight,
        })
      }
    }
  }

  async function gotoTab(key) {
    if (location.hash.replace(/^#\/?/, '') !== key) location.hash = `#/${key}`
    for (let i = 0; i < 100; i++) {
      await wait(200)
      if (isOnPage(key)) {
        await wait(1000)
        return true
      }
    }
    return false
  }

  const root = document.documentElement
  if (SAMPLE_THEME === 'none') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', SAMPLE_THEME)
  await wait(120)

  visited.push(`${SAMPLE_THEME}:console`)
  distinct.push('console')
  collect('console')
  for (const key of PAGES) {
    if (key === 'console') continue
    if (!(await gotoTab(key))) {
      visited.push(`MISS:${key}`)
      continue
    }
    visited.push(`${SAMPLE_THEME}:${key}`)
    distinct.push(key)
    collect(key)
  }

  nodes.sort((a, b) => (a.page + a.path + a.color).localeCompare(b.page + b.path + b.color))
  return {
    theme: SAMPLE_THEME,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight },
    coverage: {
      requested: PAGES,
      visited,
      distinctVisited: distinct,
      distinctCount: distinct.length,
      complete9: distinct.length === PAGES.length && !visited.some((v) => String(v).startsWith('MISS:')),
    },
    nodes,
  }
}
