#!/usr/bin/env node
/**
 * G1 实验：证明「在 dsh 内的沙箱页里注入插件 = 立即热装载进当前运行中的 dsh，不重启进程」。
 *
 * 验证的是什么（分部 G 的核心主张）
 * ------------------------------
 * 分部 G 要的不是"在 dsh 里放一个能看沙箱的表"，而是**注入即生效**：
 * 注入完成后，那个插件应当已经出现在**当前这个 dsh 进程**的运行树里，
 * 而不是等下次启动。本脚本就是量这件事。
 *
 * 观测手段（三个互相独立的判据，避免单点自证）
 * -----------------------------------------
 *  1. `/api/dsh-godsh/entries` —— 热装载桥直接枚举**运行中的 Cordis loader 条目**
 *     （它的实现是 `ctx.loader.entries()`，不是我们自己的账本）。
 *  2. `/plugins/events` 的 SSE `graph` 快照 —— dsh 自己的客户端模块图。
 *     每次**重新连接**取一份快照再对比（实测该通道只在连接时发 graph）。
 *  3. **进程 PID 不变** —— 不重启这件事只能靠这个证明。
 *
 * 另外单独断言 `sandbox/status.dataDir` 等于调用方给的隔离目录：
 * 这条是防止"测试悄悄写进了用户真实沙箱"的护栏。
 *
 * 用法：
 *   node scripts/exp/g1-sandbox-inject.mjs --port 48710 --token <t> \
 *        --plugin ext-hot-test --profile godshlab --expect-datadir <隔离沙箱目录> --expect-pid <pid>
 *
 * 安全：只调用该实例自己的 `/api/dsh-godsh/*`；不改任何环境的结构文件（除了被注入的那个，
 *       而那正是本实验的目的，且注入的是临时沙箱里的测试插件）。
 */

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const PORT = Number(arg('port', '48710'))
const TOKEN = arg('token', '')
const PLUGIN = arg('plugin', 'ext-hot-test')
const PROFILE = arg('profile', 'godshlab')
const EXPECT_DATADIR = arg('expect-datadir', '')
const EXPECT_PID = arg('expect-pid', '')
/** 被注入的插件**包名**（loader 条目与模块图都按包名索引，而不是沙箱条目 id）。 */
const TARGET_PKG = arg('pkg', 'godsh-hot-test')
/** 是否在断言完"注入即生效"之后再走一遍移除，并断言补丁层被清干净（对称性）。 */
const CLEANUP = argv.includes('--cleanup')
/** DSH 家目录（用于直接读环境的补丁文件做对称性断言）。 */
const DSH_HOME = arg('dsh-home', process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\\.dsh`)

/** 读目标环境 cordis.patch.yml 里与目标包名相关的行（对称性断言的原始证据）。 */
function readPatchRow() {
  const p = `${DSH_HOME}\\profiles\\${PROFILE}\\cordis.patch.yml`
  const text = readFileSync(p, 'utf8')
  const hit = text.split(/\r?\n/).filter((l) => l.includes(TARGET_PKG))
  return { path: p, bytes: Buffer.byteLength(text), lines: hit, hasTarget: hit.length > 0 }
}

if (!['godshlab', 'godshlab2'].includes(PROFILE)) {
  console.error(`[g1] 前置断言失败：只允许操作隔离测试 profile，收到 ${PROFILE}`)
  process.exit(2)
}

import { readFileSync } from 'node:fs'

const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const base = `http://127.0.0.1:${PORT}`
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
const auth = TOKEN ? { 'x-dsh-token': TOKEN } : {}

const out = {
  port: PORT,
  profile: PROFILE,
  sandboxEntryId: PLUGIN,
  targetPackage: TARGET_PKG,
  expectedDataDir: EXPECT_DATADIR === '' ? null : EXPECT_DATADIR,
  expectedPid: EXPECT_PID === '' ? null : Number(EXPECT_PID),
  status: null,
  treeBefore: null,
  treeAfter: null,
  graphBefore: null,
  graphAfter: null,
  inject: null,
  assertions: {},
  verdict: [],
}

async function api(method, path, body) {
  try {
    const res = await fetch(`${base}${path}${q}`, {
      method,
      headers: { Accept: 'application/json', ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: null, json: null, text: e instanceof Error ? e.message : String(e) }
  }
}

/** 取一份**全新**的客户端模块图快照（连上 SSE 读到第一帧 graph 即断开）。 */
async function graphSnapshot(label, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/plugins/events${q}`, {
      headers: { Accept: 'text/event-stream', ...auth },
      signal: controller.signal,
    })
    if (!res.ok || res.body === null) return { label, count: null, hasTarget: null }
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
        if (parsed?.type !== 'graph') continue
        const ids = (parsed.graph?.entries ?? []).map((e) => e.id)
        const snap = { label, rev: parsed.graph?.rev ?? null, count: ids.length, hasTarget: ids.includes(TARGET_PKG) }
        log(`模块图快照 ${label}: entries=${snap.count} 含目标=${snap.hasTarget}`)
        return snap
      }
    }
  } catch {
    /* 超时/断开 */
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  log(`模块图快照 ${label}: 未取到 graph 帧`)
  return { label, count: null, hasTarget: null }
}

/** 运行树条目（热装载桥枚举的真实 loader 条目）。 */
async function treeHas(pkg) {
  const r = await api('GET', '/api/dsh-godsh/entries')
  const entries = Array.isArray(r.json?.entries) ? r.json.entries : []
  return {
    ok: r.status === 200,
    count: entries.length,
    has: entries.some((e) => e.name === pkg),
    names: entries.map((e) => e.name).filter((n) => typeof n === 'string' && n.startsWith('godsh')),
  }
}

// ---------------- 0) 沙箱状态（护栏：确认写的是隔离目录）----------------
const st = await api('GET', '/api/dsh-godsh/sandbox/status')
out.status = st.json?.status ?? null
log(`sandbox/status → dataDir=${String(out.status?.dataDir)} own=${String(out.status?.ownProfile)} count=${String(out.status?.count)}`)

// ---------------- 1) 基线：运行树与模块图 ----------------
out.treeBefore = await treeHas(TARGET_PKG)
log(`运行树基线：entries=${out.treeBefore.count} 含目标=${out.treeBefore.has}`)
out.graphBefore = await graphSnapshot('before')

// ---------------- 2) 注入（沙箱 → 环境 + 热装载）----------------
const inj = await api('POST', '/api/dsh-godsh/sandbox/inject', { pluginId: PLUGIN, profile: PROFILE })
out.inject = { status: inj.status, body: inj.json }
log(`inject → HTTP ${inj.status} effectiveness=${String(inj.json?.effectiveness)}`)
log(`        ${String(inj.json?.message)}`)
if (inj.json?.phases !== undefined) {
  const p = inj.json.phases
  log(`        ①preflight=${String(p.preflight?.ok)} ②physical=${String(p.physical?.ok)} ③declared=${String(p.declared?.ok)} ④hot=${String(p.hotMounted?.attempted)}/${String(p.hotMounted?.ok)}`)
}

await sleep(3000)

// ---------------- 3) 注入后：运行树与模块图 ----------------
out.treeAfter = await treeHas(TARGET_PKG)
log(`运行树注入后：entries=${out.treeAfter.count} 含目标=${out.treeAfter.has}`)
out.graphAfter = await graphSnapshot('after')

// ---------------- 3.5) 再用「移除」验证对称性（--cleanup）----------------
// 为什么要量这一步：注入会写 <profile>/cordis.patch.yml（分配层），而沙箱引擎的 remove
// **不认识分配层**。只删沙箱就会在补丁层留下指向已删包的悬空行，dsh 下次启动会
// 「failed to import loader entry … reading 'startsWith'」直接失败（实测复现过）。
// 所以「移除后补丁层是否干净」是必须断言的一条，不是可选清理。
if (CLEANUP) {
  try {
    out.patchBefore = readPatchRow()
  } catch (e) {
    out.patchBefore = `读取失败：${e instanceof Error ? e.message : String(e)}`
  }
  const rm = await api('POST', '/api/dsh-godsh/sandbox/remove', { ids: [PLUGIN] })
  out.remove = { status: rm.status, body: rm.json }
  log(`remove → HTTP ${rm.status} removed=${String(rm.json?.removed)} cleanup=${JSON.stringify(rm.json?.cleanup)}`)
  await sleep(1500)
  try {
    out.patchAfter = readPatchRow()
  } catch (e) {
    out.patchAfter = `读取失败：${e instanceof Error ? e.message : String(e)}`
  }
  out.treeAfterRemove = await treeHas(TARGET_PKG)
}

// ---------------- 4) 断言 ----------------
const sameDataDir =
  EXPECT_DATADIR === '' ? null : String(out.status?.dataDir ?? '').toLowerCase() === EXPECT_DATADIR.toLowerCase()
out.assertions = {
  A_isolatedDataDir: sameDataDir,
  B_targetAbsentBefore: out.treeBefore.has === false,
  C_injectReportedLive: inj.json?.effectiveness === 'live',
  D_targetPresentAfter: out.treeAfter.has === true,
  E_entryCountGrew: out.treeBefore.count !== null && out.treeAfter.count !== null && out.treeAfter.count > out.treeBefore.count,
  F_pidUnchanged: out.expectedPid === null ? null : processAlive(out.expectedPid),
  G_graphGainedTarget: out.graphBefore.hasTarget === false && out.graphAfter.hasTarget === true,
  // 以下两条只在 --cleanup 时判定（null 表示未测）
  H_patchHadRowAfterInject: CLEANUP ? out.patchBefore?.hasTarget === true : null,
  I_patchCleanAfterRemove: CLEANUP ? out.patchAfter?.hasTarget === false : null,
  J_treeCleanAfterRemove: CLEANUP ? out.treeAfterRemove?.has === false : null,
}
out.counts = { treeBefore: out.treeBefore.count, treeAfter: out.treeAfter.count, graphBefore: out.graphBefore.count, graphAfter: out.graphAfter.count }

if (out.assertions.A_isolatedDataDir === false) out.verdict.push('✘ 护栏触发：沙箱 dataDir 不是给定的隔离目录 —— 可能写到了用户真实沙箱，本实验作废')
if (out.assertions.B_targetAbsentBefore !== true) out.verdict.push('（基线里目标已存在 —— 本实验无法证明"注入使它出现"）')
if (out.assertions.C_injectReportedLive === true) out.verdict.push('★ 注入自报 live（沙箱服务判定：已写入运行树）')
else out.verdict.push(`（注入未自报 live：effectiveness=${String(inj.json?.effectiveness)}）`)
if (out.assertions.D_targetPresentAfter === true) out.verdict.push(`★ 运行树里出现了 ${TARGET_PKG} —— 热装载真的把条目建进了当前进程`)
if (out.assertions.E_entryCountGrew === true) out.verdict.push(`★ 运行树条目数 ${String(out.treeBefore.count)} → ${String(out.treeAfter.count)}`)
if (out.assertions.F_pidUnchanged === true) out.verdict.push('★ dsh 进程 PID 全程未变 —— 确实没有重启')
if (out.assertions.G_graphGainedTarget === true) out.verdict.push('★ 客户端模块图也新增了该包（浏览器半可被加载）')
else out.verdict.push('（客户端模块图未新增该包）')
if (CLEANUP) {
  if (out.assertions.H_patchHadRowAfterInject === true) out.verdict.push('★ 注入确实把声明写进了环境补丁层（cordis.patch.yml 里能看到该行）')
  if (out.assertions.I_patchCleanAfterRemove === true) out.verdict.push('★ 移除后补丁层里已无该行 —— 注入/移除在声明层上是对称的（不会留下会让环境起不来的悬空行）')
  else out.verdict.push('✘ 移除后补丁层仍残留该行 —— 这会让环境下次启动直接失败')
  if (out.assertions.J_treeCleanAfterRemove === true) out.verdict.push('★ 移除后运行树里也没有该条目')
}

console.log('\n===== G1 RESULT (JSON) =====')
console.log(JSON.stringify(out, null, 2))

/** `kill 0` 探测进程是否仍在（EPERM 表示在但无权限，也算活着）。 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}
