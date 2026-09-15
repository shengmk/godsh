#!/usr/bin/env node
/**
 * G0/G1/G2 实验：DSH 的「活层装载通道」是否成立。
 *
 * 背景（本方案的支点，来自读码）
 * ----------------------------
 * `dsh/lib/profile-boot-*.js` 里 `composeLive()` 每次重放都**重新读磁盘**的只有两处：
 *   - `<profile>/cordis.patch.yml`（profile 用户层）
 *   - `$DSH_HOME/cordis.patch.yml`（home 用户层）
 * 而 `composed.bundlePatches`（即 `dsh.profile.bundles`）与 `--patch` overlay 都是启动时
 * 抓拍的快照。`watchUserPatches` 通过 `hmr.registerConfig(filename, refresh)` 在文件变化时
 * 调用 `entry.update({ config: { ...includeConfig, patches } })` —— 即**整栈事务性重放**。
 *
 * 但这份监听需要 Cordis HMR 服务存在，而它的构造函数要求 `ctx.loader.internal`，
 * 后者依赖 `process.execArgv.includes('--expose-internals')`。
 *
 * 本实验就是把这个不一致钉死：
 *   1. 起一个隔离的测试 profile（默认 godshlab），记录 PID；
 *   2. 订阅 `/plugins/events`（SSE）观察 graph 帧；
 *   3. 抓取 `GET /` 的 HTML（内含 `window.__DSH_BOOT__` 的客户端模块图）；
 *   4. 运行中往 `<profile>/cordis.patch.yml` **原子追加**一条 insert 行，
 *      目标是 `@deepseek-ai/dsh-client-ui-directory-picker-browse`（官方包里
 *      声明了 `dsh.client` 但默认未挂载 —— 全新客户端半的完美测试对象）；
 *   5. 观察四件事：进程是否存活 / SSE 是否推 graph 帧 / `GET /` 是否出现该包 / 退出码；
 *   6. 还原 patch 文件、杀进程，输出 JSON 结论。
 *
 * 用法：
 *   node scripts/exp/g0-hot-layer.mjs --flag none
 *   node scripts/exp/g0-hot-layer.mjs --flag expose-internals
 *   node scripts/exp/g0-hot-layer.mjs --flag none --port 4862 --profile godshlab
 *
 * 安全约束（硬性，本项目踩过坑）：
 *   - 只操作 --profile 指定的那一个 profile，绝不触碰 web / hajimi / webtest / dev / myenv；
 *   - 绝不使用 4780 / 4781 / 3919 端口；
 *   - 不改 `dsh.profile.bundles`（那是冷层，本实验要证明的正是它无效）；
 *   - 结束时一定还原 patch 文件并杀掉自己起的进程；
 *   - 变量名不得与 PowerShell 自动变量冲突（本脚本是 Node，不受影响，但调用方注意）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const FLAG = arg('flag', 'none')
const PROFILE = arg('profile', 'godshlab')
const PORT = Number(arg('port', FLAG === 'expose-internals' ? '4861' : '4860'))
const PROBE_PKG = arg('pkg', '@deepseek-ai/dsh-client-ui-directory-picker-browse')
const PROBE_ROW_ID = 'godsh-g0-probe'
const SETTLE_MS = Number(arg('settle', '18000'))
const ACCEPT_ENCODING = 'gzip, deflate, br' // 必须带：本项目最严重的事故正是这个头部触发的

const DSH_BIN = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DSH_HOME = join(process.env.USERPROFILE ?? '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')

const t0 = Date.now()
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()

// ---------------- 前置硬断言 ----------------
const guards = []
function guard(label, ok, detail) {
  guards.push({ label, ok, detail })
  if (!ok) {
    console.error(`[G0] 前置断言失败：${label} —— ${detail}`)
    process.exit(2)
  }
}

guard('dsh bin 存在', existsSync(DSH_BIN), DSH_BIN)
guard('目标 profile 存在', existsSync(PATCH_FILE), PATCH_FILE)
guard('禁用端口（不与既有服务冲突）', ![4780, 4781, 3919].includes(PORT), `port=${PORT}`)
guard('必须操作隔离测试 profile', ['godshlab', 'godshlab2'].includes(PROFILE), `profile=${PROFILE}`)
guard('flag 取值合法', ['none', 'expose-internals'].includes(FLAG), `flag=${FLAG}`)

// ---------------- 快照与还原 ----------------
const originalPatch = readFileSync(PATCH_FILE, 'utf8')
const originalHash = sha256(PATCH_FILE)
const backupPath = join(tmpdir(), `g0-${PROFILE}-cordis.patch.yml.bak-${Date.now()}`)
copyFileSync(PATCH_FILE, backupPath)
const credentialsPath = join(DSH_HOME, '.credentials.yaml')
const credentialsHashBefore = existsSync(credentialsPath) ? sha256(credentialsPath) : null

function writePatchAtomic(content) {
  const tmp = `${PATCH_FILE}.tmp-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, PATCH_FILE) // 原子：活层是整栈重放，半截文件会让整棵树的补丁栈失效
}

function restorePatch() {
  writePatchAtomic(originalPatch)
  const nowHash = sha256(PATCH_FILE)
  return { restored: nowHash === originalHash, nowHash, originalHash }
}

// ---------------- 启动被测 dsh ----------------
const nodeArgs = FLAG === 'expose-internals' ? ['--expose-internals', DSH_BIN] : [DSH_BIN]
const outFile = join(tmpdir(), `g0-${FLAG}-${PORT}.log`)
const outFd = openSync(outFile, 'w')

log(`启动 dsh profile=${PROFILE} port=${PORT} flag=${FLAG}`)
log(`命令：node ${nodeArgs.join(' ')} --profile ${PROFILE} --port ${PORT} --no-open`)

const child = spawn(process.execPath, [...nodeArgs, '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  // stdio 直接落文件（不用 pipe），避免任何管道/权限边界问题
  stdio: ['ignore', outFd, outFd],
  env: { ...process.env, NO_COLOR: '1' },
  windowsHide: true,
})

const result = {
  flag: FLAG,
  profile: PROFILE,
  port: PORT,
  probePackage: PROBE_PKG,
  pid: child.pid,
  guards,
  started: false,
  token: null,
  url: null,
  aliveBefore: false,
  aliveAfter: false,
  patchWritten: false,
  processExitedDuringRun: false,
  exitCode: null,
  sse: { attempted: false, status: null, graphFrames: 0, rebuiltFrames: 0, otherFrames: 0, frames: [] },
  bootHtml: { beforeHasProbe: null, afterHasProbe: null, beforeBytes: 0, afterBytes: 0 },
  stderrHasExposeInternalsError: false,
  logFile: outFile,
  restore: null,
  credentialsHashBefore,
  credentialsHashAfter: null,
  conclusion: [],
}

function readLog() {
  try {
    return readFileSync(outFile, 'utf8')
  } catch {
    return ''
  }
}

// ---------------- 等 token 地址 ----------------
let token = null
for (let i = 0; i < 120; i++) {
  const text = readLog()
  const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]+)/)
  if (m) {
    token = m[2]
    break
  }
  if (child.exitCode !== null) break
  await sleep(250)
}

result.token = token
result.url = token ? `http://127.0.0.1:${PORT}/?token=${token}` : null
result.started = token !== null
log(token ? `已拿到认证地址（token 长度 ${token.length}）` : '未拿到认证地址 —— 见日志')

async function probe(label) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
      headers: { 'Accept-Encoding': ACCEPT_ENCODING, ...(token ? { 'x-dsh-token': token } : {}) },
      signal: AbortSignal.timeout(8000),
    })
    // 任何 HTTP 响应（含 401/403/303）都说明进程活着；只有连接被重置/超时才算死
    log(`探活 ${label}: HTTP ${res.status}`)
    return { ok: true, status: res.status }
  } catch (e) {
    log(`探活 ${label}: 失败 ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, status: null }
  }
}

async function fetchIndex(tag) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/${token ? `?token=${token}` : ''}`, {
      headers: { 'Accept-Encoding': ACCEPT_ENCODING, ...(token ? { 'x-dsh-token': token } : {}) },
      signal: AbortSignal.timeout(10000),
    })
    const html = await res.text()
    const hasProbe = html.includes(PROBE_PKG)
    log(`GET / (${tag}): HTTP ${res.status}, ${html.length} 字节, 含探针包名=${hasProbe}`)
    return { ok: true, html, hasProbe, bytes: html.length }
  } catch (e) {
    log(`GET / (${tag}) 失败: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, html: '', hasProbe: null, bytes: 0 }
  }
}

if (!token) {
  // 没起来也要如实记录，不要伪造
  result.stderrHasExposeInternalsError = readLog().includes('--expose-internals is required')
  result.conclusion.push('未拿到认证地址：dsh 没有进入可用状态，见日志文件')
} else {
  const before = await probe('启动后')
  result.aliveBefore = before.ok

  const idxBefore = await fetchIndex('before')
  result.bootHtml.beforeHasProbe = idxBefore.hasProbe
  result.bootHtml.beforeBytes = idxBefore.bytes

  // ---------------- SSE 观察 ----------------
  const sseUrl = `http://127.0.0.1:${PORT}/plugins/events${token ? `?token=${token}` : ''}`
  result.sse.attempted = true
  const sseController = new AbortController()
  const sseTask = (async () => {
    try {
      const res = await fetch(sseUrl, {
        headers: { Accept: 'text/event-stream', ...(token ? { 'x-dsh-token': token } : {}) },
        signal: sseController.signal,
      })
      result.sse.status = res.status
      if (!res.ok || res.body === null) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLine = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
          if (dataLine === '') continue
          let type = 'unparseable'
          try {
            type = JSON.parse(dataLine)?.type ?? 'unknown'
          } catch {
            /* 保持 unparseable */
          }
          if (type === 'graph') result.sse.graphFrames++
          else if (type === 'rebuilt') result.sse.rebuiltFrames++
          else result.sse.otherFrames++
          if (result.sse.frames.length < 20) result.sse.frames.push({ type, preview: dataLine.slice(0, 90) })
        }
      }
    } catch {
      /* abort 或网络错误：如实记为无帧 */
    }
  })()

  await sleep(2500) // 让 SSE 先建立

  // ---------------- 写活层 ----------------
  const insertRow = {
    insert: [{ id: PROBE_ROW_ID, name: PROBE_PKG }],
  }
  // 保留原有的顶层数组结构；把新行追加进去（yaml 手工拼装，保持最小改动）
  const yamlRow = `- insert:\n    - id: ${PROBE_ROW_ID}\n      name: '${PROBE_PKG}'\n`
  const nextPatch = originalPatch.includes('\n[]')
    ? originalPatch.replace(/\n\[\]\s*$/, `\n${yamlRow}`)
    : `${originalPatch.replace(/\s*$/, '')}\n${yamlRow}`
  writePatchAtomic(nextPatch)
  result.patchWritten = true
  result.patchRow = insertRow
  log(`已原子写入活层 insert 行：id=${PROBE_ROW_ID} name=${PROBE_PKG}`)

  // ---------------- 等生效并观察 ----------------
  await sleep(SETTLE_MS)

  result.processExitedDuringRun = child.exitCode !== null
  result.exitCode = child.exitCode
  log(`观察窗口结束：进程 ${child.exitCode === null ? '仍在运行' : `已退出(exit=${child.exitCode})`}`)

  if (child.exitCode === null) {
    const after = await probe('写活层后')
    result.aliveAfter = after.ok
    const idxAfter = await fetchIndex('after')
    result.bootHtml.afterHasProbe = idxAfter.hasProbe
    result.bootHtml.afterBytes = idxAfter.bytes
  }

  sseController.abort()
  await sseTask.catch(() => {})

  const text = readLog()
  result.stderrHasExposeInternalsError = text.includes('--expose-internals is required')

  // ---------------- 结论 ----------------
  if (result.patchWritten && result.aliveAfter && result.bootHtml.afterHasProbe === true) {
    result.conclusion.push('G0=成立：运行中改 profile 活层，新包的客户端半进入了 boot 图（GET / 出现探针包名）')
    result.conclusion.push('G1=成立：宿主侧新 row 被装载（否则 dsh-client-modules 不会把它纳入图）')
  } else if (result.patchWritten && result.aliveAfter && result.bootHtml.afterHasProbe === false) {
    result.conclusion.push('G0/G1=不成立：进程存活但 boot 图未变 —— 活层监听未生效（或该 row 装载失败）')
  } else if (result.patchWritten && !result.aliveAfter) {
    result.conclusion.push('进程在写活层后不可用 —— 该操作把树弄坏了（这是必须避免的失败模式）')
  } else {
    result.conclusion.push('无法得出结论，见各项观测值')
  }
  if (result.sse.graphFrames > 0) {
    result.conclusion.push(`SSE 收到 ${result.sse.graphFrames} 个 graph 帧 —— 客户端模块图在运行期发生了变化`)
  } else if (result.sse.status !== null) {
    result.conclusion.push(`SSE 连接建立（HTTP ${result.sse.status}）但未收到任何 graph 帧`)
  }
  if (result.stderrHasExposeInternalsError) {
    result.conclusion.push('日志中出现 "--expose-internals is required" —— HMR 服务构造失败，活层监听不可用')
  }
}

// ---------------- 收尾 ----------------
try {
  child.kill('SIGKILL')
} catch {
  /* 可能已退出 */
}
await sleep(1200)
result.restore = restorePatch()
result.credentialsHashAfter = existsSync(credentialsPath) ? sha256(credentialsPath) : null
log(`patch 已还原=${result.restore.restored}`)
log(`credentials.yaml 未变=${result.credentialsHashBefore === result.credentialsHashAfter}`)

console.log('\n===== G0 RESULT (JSON) =====')
console.log(JSON.stringify(result, null, 2))
