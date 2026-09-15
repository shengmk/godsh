#!/usr/bin/env node
/**
 * G0/G1 判别器：附着一个**已在运行**的 dsh 实例，用三种「活层写入」分别判定
 * 「profile 用户层 cordis.patch.yml 是否真的被监听并重放」。
 *
 * 为什么需要三种模式（单靠 insert 一种无法定因）
 * --------------------------------------------
 * 只写一条 insert 行而图没变，有两种可能：
 *   (A) 活层监听根本没生效；或
 *   (B) 监听生效了，但这条 row 解析/装载失败（例如包名在 profile 里解析不到）。
 * 因此必须加上两条**只依赖已存在 row** 的探针：
 *   - `--mode disable`：对**已在图中**的 row 做 id 定向 `disabled: true`。
 *     若监听生效，该 row 的 entry 会从图中消失（无需任何解析）。
 *   - `--mode broken`：写一份**非法的**补丁文件（顶层是映射而不是数组）。
 *     若监听生效，刷新回调里 `loadOptionalPatches` 必然抛错 → `hmr/config-update-failed`，
 *     通常会在 dsh 的输出里有痕迹；若输出毫无变化，说明没有任何人在监听。
 * 三者的组合即可把 (A) 与 (B) 区分开。
 *
 * 用法：
 *   node scripts/exp/g0-verify.mjs --port 4865 --token <t> --mode disable --target dsh-client-ui-open-in-app
 *   node scripts/exp/g0-verify.mjs --port 4865 --token <t> --mode broken --dsh-log %TEMP%\x.out.log --dsh-err %TEMP%\x.err.log
 *   node scripts/exp/g0-verify.mjs --port 4865 --token <t> --mode insert --pkg <pkg>
 *
 * 安全：只写指定 profile 的 cordis.patch.yml 并保证还原；不碰 dsh.profile.bundles；
 *       只允许操作 godshlab / godshlab2 这两个隔离测试 profile。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const PORT = Number(arg('port', '4865'))
const TOKEN = arg('token', '')
const PROFILE = arg('profile', 'godshlab')
const MODE = arg('mode', 'insert')
const PROBE_PKG = arg('pkg', '@deepseek-ai/dsh-client-ui-directory-picker-browse')
/** patch row 的 id（**短名**，如 `ui-open-in-app`）—— 与图条目 id（**完整包名**）是两回事，不能混用。 */
const TARGET = arg('target', 'ui-open-in-app')
/** 目标 row 对应的完整包名，用于在图条目里查找（图条目的 id 是包名）。 */
const TARGET_PKG = arg('target-pkg', '@deepseek-ai/dsh-client-ui-open-in-app')
/** 活层写入方式：atomic（temp+rename，生产写法）| inplace（原地覆写，用于检验 rename 是否弄丢 watch）。 */
const WRITE = arg('write', 'atomic')
const SETTLE_MS = Number(arg('settle', '20000'))
const DSH_LOG = arg('dsh-log', '')
const DSH_ERR = arg('dsh-err', '')

const PATCH_FILE = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', PROFILE, 'cordis.patch.yml')

const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').toUpperCase()
const readMaybe = (f) => (f !== '' && existsSync(f) ? readFileSync(f, 'utf8') : null)

if (!existsSync(PATCH_FILE)) {
  console.error(`前置断言失败：${PATCH_FILE} 不存在`)
  process.exit(2)
}
if (!['godshlab', 'godshlab2'].includes(PROFILE)) {
  console.error(`前置断言失败：只允许操作隔离测试 profile，收到 ${PROFILE}`)
  process.exit(2)
}
if (!['insert', 'disable', 'broken'].includes(MODE)) {
  console.error(`前置断言失败：mode 必须是 insert / disable / broken，收到 ${MODE}`)
  process.exit(2)
}

const original = readFileSync(PATCH_FILE, 'utf8')
const originalHash = sha256(PATCH_FILE)
copyFileSync(PATCH_FILE, join(tmpdir(), `g0-verify-${PROFILE}-${Date.now()}.bak`))

const writeAtomic = (content) => {
  // WRITE=atomic（默认）：temp + rename —— 这是本项目生产代码的写法（防半截文件）。
  // WRITE=inplace：直接原地覆写 —— 用来检验「rename 是否把 chokidar 的 watch 弄丢」。
  //   Windows 上 rename 覆盖会改变文件标识，fs.watch/ReadDirectoryChangesW 有时会因此
  //   静默失去对该路径的关注；若 atomic 不触发而 inplace 触发，那就是本机的真实成因。
  if (WRITE === 'inplace') {
    writeFileSync(PATCH_FILE, content, 'utf8')
    return
  }
  const tmp = `${PATCH_FILE}.tmp-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, PATCH_FILE)
}

const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
const sseHeaders = { Accept: 'text/event-stream', ...(TOKEN ? { 'x-dsh-token': TOKEN } : {}) }

const out = {
  port: PORT,
  profile: PROFILE,
  mode: MODE,
  write: WRITE,
  probePackage: MODE === 'insert' ? PROBE_PKG : null,
  targetRowId: MODE === 'disable' ? TARGET : null,
  targetPackage: MODE === 'disable' ? TARGET_PKG : null,
  patchOriginalHash: originalHash,
  graphFrames: [],
  dshLogBefore: null,
  dshLogAfter: null,
  dshErrBefore: null,
  dshErrAfter: null,
  restore: {},
  verdict: [],
}

// ---------- SSE：抓全部 graph 帧 ----------
const controller = new AbortController()
const sseTask = (async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/plugins/events${q}`, { headers: sseHeaders, signal: controller.signal })
    out.sseStatus = res.status
    if (!res.ok || res.body === null) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (data === '') continue
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        if (parsed?.type === 'graph') {
          const entries = parsed.graph?.entries ?? []
          const ids = entries.map((e) => e.id)
          const rec = {
            t: ((Date.now() - t0) / 1000).toFixed(1),
            rev: parsed.graph?.rev,
            count: ids.length,
            hasProbe: PROBE_PKG !== '' && ids.includes(PROBE_PKG),
            hasTarget: ids.includes(TARGET_PKG),
          }
          out.graphFrames.push(rec)
          log(
            `graph 帧 t=${rec.t}s rev=${rec.rev} entries=${rec.count}` +
              ` hasProbe(${PROBE_PKG})=${rec.hasProbe} hasTarget(${TARGET_PKG})=${rec.hasTarget}`
          )
        } else {
          log(`非 graph 帧: ${JSON.stringify(parsed).slice(0, 120)}`)
        }
      }
    }
  } catch {
    /* abort 正常 */
  }
})()

await sleep(2000)
out.dshLogBefore = readMaybe(DSH_LOG)
out.dshErrBefore = readMaybe(DSH_ERR)

// ---------- 写活层 ----------
let payload
if (MODE === 'insert') {
  payload = `- insert:\n    - id: godsh-g0-probe\n      name: '${PROBE_PKG}'\n`
} else if (MODE === 'disable') {
  payload = `- id: ${TARGET}\n  disabled: true\n`
} else {
  payload = `this: is not a patch array\n`
}
const next = original.includes('\n[]') ? original.replace(/\n\[\]\s*$/, `\n${payload}`) : `${original.replace(/\s*$/, '')}\n${payload}`
writeAtomic(next)
log(`已写入活层（mode=${MODE}）：`)
log(readFileSync(PATCH_FILE, 'utf8'))

await sleep(SETTLE_MS)

out.dshLogAfter = readMaybe(DSH_LOG)
out.dshErrAfter = readMaybe(DSH_ERR)

controller.abort()
await sseTask.catch(() => {})

writeAtomic(original)
out.restore = { hash: sha256(PATCH_FILE), ok: sha256(PATCH_FILE) === originalHash }
log(`patch 已还原=${out.restore.ok}`)

// ---------- 判定 ----------
const frames = out.graphFrames
const first = frames[0]
const last = frames[frames.length - 1]
const baselineCount = first?.count ?? null
const logGrew = out.dshLogAfter !== null && out.dshLogBefore !== null && out.dshLogAfter.length > out.dshLogBefore.length
const errGrew = out.dshErrAfter !== null && out.dshErrBefore !== null && out.dshErrAfter.length > out.dshErrBefore.length

out.observations = {
  frameCount: frames.length,
  baselineEntryCount: baselineCount,
  lastEntryCount: last?.count ?? null,
  entryCountChanged: baselineCount !== null && last !== undefined && last.count !== baselineCount,
  probeAppeared: frames.some((f) => f.hasProbe),
  // ⚠️ 关键修正：图条目的 id 是**完整包名**（如 `@deepseek-ai/dsh-client-ui-open-in-app`），
  //    不是 patch row 的短 id。原先用短 id 判定会得到「基线里就没有它 → hasTarget 恒 false
  //    → targetDisappeared 恒 true」的**假阳性**。故必须分两段判定：
  //    ① 基线帧里 target 必须**存在**（否则这条探针无效，不能下任何结论）；
  //    ② 之后的某一帧里 target 消失，才算监听生效。
  baselineHasTarget: first?.hasTarget ?? null,
  targetPresentLater: frames.some((f) => f.hasTarget),
  targetAbsentLater: frames.some((f) => !f.hasTarget),
  targetDisappeared:
    first?.hasTarget === true && frames.slice(1).some((f) => !f.hasTarget),
  disableProbeValid: MODE !== 'disable' || first?.hasTarget === true,
  dshLogGrew: logGrew,
  dshErrGrew: errGrew,
  newLogChars: out.dshLogAfter !== null && out.dshLogBefore !== null ? out.dshLogAfter.length - out.dshLogBefore.length : null,
}

if (MODE === 'disable') {
  if (out.observations.disableProbeValid !== true) {
    out.verdict.push(
      `本条探针**无效**：目标 "${TARGET}" 在基线图里就不存在（图条目 id 是完整包名）。` +
        `必须用完整包名重测；本轮不得据此下任何结论。`
    )
  } else if (out.observations.targetDisappeared) {
    out.verdict.push('★ 活层监听生效：对**已存在** row 的 id 定向 disabled 覆盖在运行期起了作用（图条目消失）')
  } else {
    out.verdict.push('活层监听**未生效**：对已存在 row 的覆盖没有任何反应（不依赖包解析，故排除「解析失败」这一解释）')
  }
}
if (MODE === 'broken') {
  if (logGrew || errGrew || out.observations.entryCountChanged) {
    out.verdict.push('★ 活层有监听者：写入非法补丁后出现了输出或图变化（说明刷新回调被触发并失败）')
  } else {
    out.verdict.push('无任何监听痕迹：写入非法补丁后 dsh 输出与图都毫无变化 —— 支持「活层根本没人监听」')
  }
}
if (MODE === 'insert') {
  if (out.observations.probeAppeared) out.verdict.push('★ 新 row 装载成功并进入客户端图')
  else if (out.observations.entryCountChanged) out.verdict.push('图条目数变了但没有探针包 —— row 装载后又被卸载/替换，需细看')
  else out.verdict.push('新 row 未进入图（可能因活层未监听，或该包在 profile 中解析不到）')
}

console.log('\n===== G0 VERIFY RESULT (JSON) =====')
console.log(JSON.stringify(out, null, 2))
