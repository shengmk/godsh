#!/usr/bin/env node
/**
 * G0/G1/G2 观察器：附着一个**已在运行**的 dsh 实例，验证「活层装载通道」。
 *
 * 与 `g0-hot-layer.mjs` 的分工：
 *   - `g0-hot-layer.mjs`：自己起 dsh（含 --expose-internals 与否两种），适合冷启动对比；
 *   - 本脚本：附着一个已经跑起来的实例（token 由调用方给出），只做观察与写活层。
 *
 * 关键背景（来自 dsh-web-app/lib/index.js:194-217 的实测读码）：
 *   认证地址只在 `loader.await()` 结算**且** webServer 与 connection 都就位后才打印，
 *   所以「端口已在监听」远早于「URL 被打印」。本机实测：新 profile 首启约需 70 秒
 *   才会打印 URL。不要因为 30 秒没看到 URL 就判定启动失败。
 *
 * 用法：
 *   node scripts/exp/g0-observe.mjs --port 4864 --token <token> [--pkg <pkg>] [--settle 18000]
 *
 * 安全：只写 --profile 指定的 profile（默认 godshlab）的 cordis.patch.yml，结束时还原；
 *       绝不触碰 dsh.profile.bundles。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const PORT = Number(arg('port', '4864'))
const TOKEN = arg('token', '')
const PROFILE = arg('profile', 'godshlab')
const PROBE_PKG = arg('pkg', '@deepseek-ai/dsh-client-ui-directory-picker-browse')
const PROBE_ROW_ID = 'godsh-g0-probe'
const SETTLE_MS = Number(arg('settle', '20000'))
const ACCEPT_ENCODING = 'gzip, deflate, br'

const DSH_HOME = join(process.env.USERPROFILE ?? '', '.dsh')
const PATCH_FILE = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')

const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').toUpperCase()

if (!existsSync(PATCH_FILE)) {
  console.error(`[g0-observe] 前置断言失败：profile patch 不存在 ${PATCH_FILE}`)
  process.exit(2)
}
if (!['godshlab', 'godshlab2'].includes(PROFILE)) {
  console.error(`[g0-observe] 前置断言失败：只允许操作隔离测试 profile，收到 ${PROFILE}`)
  process.exit(2)
}

const originalPatch = readFileSync(PATCH_FILE, 'utf8')
const originalHash = sha256(PATCH_FILE)
const backup = join(tmpdir(), `g0-observe-${PROFILE}-${Date.now()}.bak`)
copyFileSync(PATCH_FILE, backup)

function writePatchAtomic(content) {
  const tmp = `${PATCH_FILE}.tmp-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, PATCH_FILE)
}

const headers = { 'Accept-Encoding': ACCEPT_ENCODING }
if (TOKEN) headers['x-dsh-token'] = TOKEN
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''

const out = {
  port: PORT,
  profile: PROFILE,
  probePackage: PROBE_PKG,
  tokenProvided: TOKEN !== '',
  indexBefore: null,
  indexAfter: null,
  sse: { status: null, graphFrames: 0, rebuiltFrames: 0, otherFrames: 0, frames: [] },
  patch: { originalHash, restored: null, restoredHash: null },
  conclusion: [],
}

async function getIndex(tag) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/${q}`, { headers, signal: AbortSignal.timeout(20000) })
    const html = await res.text()
    const hasProbe = html.includes(PROBE_PKG)
    const bootMatch = html.match(/__DSH_BOOT__\s*=\s*(\{[\s\S]{0,200})/)
    log(`GET / (${tag}) → HTTP ${res.status}, ${html.length} 字节, 含探针包名=${hasProbe}`)
    if (bootMatch) log(`   __DSH_BOOT__ 片段: ${bootMatch[1].slice(0, 120).replace(/\s+/g, ' ')}`)
    return { status: res.status, bytes: html.length, hasProbe, html }
  } catch (e) {
    log(`GET / (${tag}) 失败: ${e instanceof Error ? e.message : String(e)}`)
    return { status: null, bytes: 0, hasProbe: null, html: '' }
  }
}

// ---------- 1. 写活层之前的基线 ----------
const before = await getIndex('before')
out.indexBefore = { status: before.status, bytes: before.bytes, hasProbe: before.hasProbe }

// ---------- 2. 建立 SSE 观察 ----------
const sseController = new AbortController()
const sseTask = (async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/plugins/events${q}`, {
      headers: { Accept: 'text/event-stream', ...(TOKEN ? { 'x-dsh-token': TOKEN } : {}) },
      signal: sseController.signal,
    })
    out.sse.status = res.status
    log(`SSE /plugins/events → HTTP ${res.status}`)
    if (!res.ok || res.body === null) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let i
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (data === '') continue
        let type = 'unparseable'
        try {
          type = JSON.parse(data)?.type ?? 'unknown'
        } catch {
          /* keep */
        }
        if (type === 'graph') out.sse.graphFrames++
        else if (type === 'rebuilt') out.sse.rebuiltFrames++
        else out.sse.otherFrames++
        if (out.sse.frames.length < 30) out.sse.frames.push({ t: ((Date.now() - t0) / 1000).toFixed(1), type, preview: data.slice(0, 100) })
        log(`SSE 帧: type=${type}  ${data.slice(0, 110)}`)
      }
    }
  } catch {
    /* abort 或断开 */
  }
})()

await sleep(2500)

// ---------- 3. 原子写入活层 insert 行 ----------
const yamlRow = `- insert:\n    - id: ${PROBE_ROW_ID}\n      name: '${PROBE_PKG}'\n`
const nextPatch = originalPatch.includes('\n[]')
  ? originalPatch.replace(/\n\[\]\s*$/, `\n${yamlRow}`)
  : `${originalPatch.replace(/\s*$/, '')}\n${yamlRow}`
writePatchAtomic(nextPatch)
log(`已原子写入活层：id=${PROBE_ROW_ID} name=${PROBE_PKG}`)
log(`写入后的 patch 文件内容：\n${readFileSync(PATCH_FILE, 'utf8')}`)

// ---------- 4. 等生效并观察 ----------
await sleep(SETTLE_MS)

const after = await getIndex('after')
out.indexAfter = { status: after.status, bytes: after.bytes, hasProbe: after.hasProbe }

sseController.abort()
await sseTask.catch(() => {})

// ---------- 5. 还原 ----------
writePatchAtomic(originalPatch)
out.patch.restoredHash = sha256(PATCH_FILE)
out.patch.restored = out.patch.restoredHash === originalHash
log(`patch 已还原=${out.patch.restored}`)

// ---------- 6. 结论 ----------
if (out.indexBefore?.hasProbe === false && out.indexAfter?.hasProbe === true) {
  out.conclusion.push('★ G0/G1 成立：运行中写 profile 活层，新包的客户端半**进入了 boot 图**（GET / 由「不含」变为「含」探针包名）')
  out.conclusion.push('  推论：宿主侧新 row 确实被装载了（否则 dsh-client-modules 不会把它纳入可服务图）')
} else if (out.indexBefore?.hasProbe === false && out.indexAfter?.hasProbe === false) {
  out.conclusion.push('G0/G1 不成立：boot 图未变化 —— 活层监听未生效，或该 row 装载失败')
} else if (out.indexAfter?.hasProbe === true) {
  out.conclusion.push('探针包名本来就出现在 boot 图里（探测对象选得不对，需换包重测）')
}
if (out.sse.graphFrames > 0) out.conclusion.push(`SSE 收到 ${out.sse.graphFrames} 个 graph 帧 —— 客户端模块图在运行期发生了变化`)
else out.conclusion.push(`SSE 未收到 graph 帧（状态码 ${out.sse.status}）`)

console.log('\n===== G0 OBSERVE RESULT (JSON) =====')
console.log(JSON.stringify(out, null, 2))
