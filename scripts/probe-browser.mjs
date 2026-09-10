#!/usr/bin/env node
/**
 * 浏览器探针驱动：用 Chrome DevTools Protocol 打开一个真实页面、注入一段 JS 并取回 JSON 结果。
 *
 * 为什么需要它：`chrome --dump-dom` 只能拿到静态 DOM 快照，无法在**真实渲染的页面**里
 * 执行测量代码（对比度、溢出、列表节点数这些都必须在页面里算）。本脚本补上这一能力。
 *
 * 用法：
 *   node scripts/probe-browser.mjs --url http://127.0.0.1:4790/ --js <payload.mjs|payload.js> [--wait <selector>] [--timeout 60000]
 *
 * payload 文件内容：一段**表达式**（可以是 async IIFE），其返回值会被 JSON 序列化后从 stdout 打印。
 * 约定 payload 内可以用 `document` 等浏览器 API，但不能用 Node API。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const url = opt('url')
const jsFile = opt('js')
const waitSelector = opt('wait', 'body')
const timeoutMs = Number(opt('timeout', '60000'))
if (!url || !jsFile) {
  console.error('用法: node scripts/probe-browser.mjs --url <url> --js <payload file> [--wait <selector>]')
  process.exit(2)
}
const payload = readFileSync(jsFile, 'utf8')

function findChrome() {
  const candidates = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]
  return candidates.find((p) => p && existsSync(p))
}

const chromePath = findChrome()
if (!chromePath) {
  console.error('未找到 Chrome/Edge')
  process.exit(1)
}

const port = 9200 + Math.floor(Math.random() * 300)
const profileDir = mkdtempSync(join(tmpdir(), 'godsh-cdp-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return res.json()
}

let ws
let seq = 0
const pending = new Map()

function send(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

function cleanup(code) {
  try {
    ws?.close()
  } catch {}
  try {
    chrome.kill()
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {}
    process.exit(code)
  }, 200)
}

try {
  // 等 DevTools 端点就绪
  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      version = await httpJson('/json/version')
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('DevTools 端点未就绪')

  const target = await httpJson('/json/list').then((t) => t.find((x) => x.type === 'page'))
  if (!target) throw new Error('未找到 page target')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  await send('Page.enable')
  await send('Runtime.enable')
  // 固定视口：headless 默认窗口很小（实测 762×484），会让「横向是否溢出」这类判断失真
  const width = Number(opt('width', '1440'))
  const height = Number(opt('height', '900'))
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })

  // 等目标选择器出现（应用渲染完成）
  const deadline = Date.now() + timeoutMs
  let ready = false
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(waitSelector)})`,
      returnByValue: true,
    })
    if (r?.result?.value === true) {
      ready = true
      break
    }
    await sleep(300)
  }
  if (!ready) console.error(`[probe] 警告：等待 ${waitSelector} 超时，仍尝试测量`)

  const out = await send('Runtime.evaluate', {
    expression: `(async () => { ${payload} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (out.exceptionDetails) {
    console.error('[probe] 页面内脚本抛错：')
    console.error(JSON.stringify(out.exceptionDetails.exception?.description ?? out.exceptionDetails, null, 2))
    cleanup(1)
  } else {
    console.log(JSON.stringify(out.result.value, null, 2))
    cleanup(0)
  }
} catch (e) {
  console.error(`[probe] 失败：${e.message}`)
  cleanup(1)
}
