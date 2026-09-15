#!/usr/bin/env node
/**
 * H1 实验：证明「不重启 dsh 进程即可热装载/热卸载插件」。
 *
 * 为什么不是 G0 那条路
 * ------------------
 * G0 实测（见 `09_输入文档/新文档/G0实验结论-活层装载通道.md`）证明 dsh 自己那段
 * 「监听 `cordis.patch.yml` 并整栈重放」的逻辑在本机**不生效**（四类探针 × 两种启动
 * flag 全部零效果）。所以本实验验证的是另一条路：
 *
 *   **在插件自己的 `apply()` 里直接操作运行中的 Cordis loader。**
 *
 * 观测手段：`/plugins/events` 的 SSE `graph` 帧。
 * 它由 dsh 的 `dsh-client-modules` 组装，帧里带**完整**的 `entries[]`（每项含包名与
 * 可加载 url）与 `rev`。因此「图条目数变化 + 目标包名出现/消失」就是"运行树真的变了"
 * 的硬证据，不需要浏览器、不需要截图。
 *
 * ⚠️ 首轮实验踩到的两个方法学坑（这里是修正后的写法，写下来免得再犯）
 * ------------------------------------------------------------------
 *  1. **不能假定 graph 帧会被"推送"。** 首轮我挂了一个长连 SSE 等新帧，结果只收到连接
 *     时的那一帧，于是把"装载成功"误判成"没生效"。正确做法是**每次重新连接取快照**
 *     （`snapshot()`），比较快照之间的差异 —— 这与 `dsh-client-hmr` 只在连接时发 graph、
 *     之后只发 `rebuilt` 的行为一致。
 *  2. **不能拿时间戳做区间过滤。** 首轮写成 `frames.filter(f => f.t > (last?.t ?? 0))`，
 *     当"上一次"为空时回退到 0，于是**基线帧本身被算进了"卸载后"的区间**，得出了
 *     "卸载后目标消失 ⇒ 热卸载生效"的**假阳性**。修正为按**快照序号**比较，
 *     不允许任何回退默认值参与判定。
 *
 * 断言（全部必须成立才算通过）
 * -------------------------
 *   A. dsh 进程 PID 全程不变（不重启）
 *   B. `/api/dsh-godsh/ping` 返回 ok（插件宿主半确实装载了）
 *   C. 装载后的快照条目数 **严格大于** 基线条目数
 *   D. 装载后的快照里出现目标包名
 *   E. 卸载后的快照里目标包名消失（且此时快照是**重新取的**，不是基线帧）
 *
 * 用法：
 *   node scripts/exp/h1-hot-mount.mjs --port 4866 --token <token> --expect-pid <pid> [--pkg <包名>]
 *
 * 安全：只操作 --profile 指定的隔离 profile（默认 godshlab），只调用该实例自己的
 *       `/api/dsh-godsh/*` 端点；不写 `dsh.profile.bundles`；不碰其它 dsh/godsh 进程。
 */

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const PORT = Number(arg('port', '4866'))
const TOKEN = arg('token', '')
const PROFILE = arg('profile', 'godshlab')
const PKG = arg('pkg', '@deepseek-ai/dsh-client-ui-directory-picker-browse')
const EXPECT_PID = arg('expect-pid', '')

if (!['godshlab', 'godshlab2'].includes(PROFILE)) {
  console.error(`[h1] 前置断言失败：只允许操作隔离测试 profile，收到 ${PROFILE}`)
  process.exit(2)
}

const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const base = `http://127.0.0.1:${PORT}`
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
const auth = TOKEN ? { 'x-dsh-token': TOKEN } : {}

const out = {
  port: PORT,
  profile: PROFILE,
  targetPackage: PKG,
  expectedPid: EXPECT_PID === '' ? null : Number(EXPECT_PID),
  ping: null,
  probe: null,
  snapshots: [],
  mount: null,
  unmount: null,
  assertions: {},
  verdict: [],
}

async function api(method, path, body) {
  try {
    const res = await fetch(`${base}${path}${q}`, {
      method,
      headers: { Accept: 'application/json', ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
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

/**
 * 取一份**全新的**客户端模块图快照：连上 SSE，读到第一帧 graph 就断开。
 *
 * 为什么不复用长连：实测该通道只在**连接时**发 graph，之后只发 `rebuilt`
 * （`dsh-client-hmr` 的浏览器半里 `case "graph": break;` 也是这个意思的旁证）。
 * 所以"图变没变"必须靠两份独立快照对比。
 */
async function snapshot(label, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/plugins/events${q}`, {
      headers: { Accept: 'text/event-stream', ...auth },
      signal: controller.signal,
    })
    if (!res.ok || res.body === null) return { label, status: res.status, count: null, rev: null, hasTarget: null }
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
        const snap = {
          label,
          t: Number(((Date.now() - t0) / 1000).toFixed(1)),
          status: res.status,
          rev: parsed.graph?.rev ?? null,
          count: ids.length,
          hasTarget: ids.includes(PKG),
        }
        log(`快照 ${label}: rev=${snap.rev} entries=${snap.count} hasTarget=${snap.hasTarget}`)
        return snap
      }
    }
  } catch {
    /* 超时/断开 */
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  log(`快照 ${label}: 未取到 graph 帧`)
  return { label, t: Number(((Date.now() - t0) / 1000).toFixed(1)), status: null, rev: null, count: null, hasTarget: null }
}

// ---------------- B. ping ----------------
const ping = await api('GET', '/api/dsh-godsh/ping')
out.ping = { status: ping.status, body: ping.json }
log(`ping → HTTP ${ping.status} ${JSON.stringify(ping.json)}`)

const probe = await api('GET', '/api/dsh-godsh/probe')
out.probe = probe.json?.probe ?? null
log(`probe → ${JSON.stringify(out.probe)}`)

// ---------------- 快照 1：基线 ----------------
const snapBaseline = await snapshot('baseline')
out.snapshots.push(snapBaseline)

// ---------------- C/D. 热装载 ----------------
const mount = await api('POST', '/api/dsh-godsh/mount', { name: PKG })
out.mount = { status: mount.status, body: mount.json }
log(`mount → HTTP ${mount.status} ${String(JSON.stringify(mount.json)).slice(0, 320)}`)

await sleep(3000)
const snapAfterMount = await snapshot('after-mount')
out.snapshots.push(snapAfterMount)

// ---------------- E. 热卸载 ----------------
const unmount = await api('POST', '/api/dsh-godsh/unmount', { name: PKG })
out.unmount = { status: unmount.status, body: unmount.json }
log(`unmount → HTTP ${unmount.status} ${String(JSON.stringify(unmount.json)).slice(0, 320)}`)

await sleep(3000)
const snapAfterUnmount = await snapshot('after-unmount')
out.snapshots.push(snapAfterUnmount)

// ---------------- 断言：按快照序号比较，不使用任何回退默认值 ----------------
const b = snapBaseline
const m = snapAfterMount
const u = snapAfterUnmount
out.assertions = {
  A_pidUnchanged: out.expectedPid === null ? null : processAlive(out.expectedPid),
  B_pluginMounted: ping.status === 200 && ping.json?.ok === true,
  C_entryCountGrew: b.count !== null && m.count !== null && m.count > b.count,
  D_targetAppeared: m.hasTarget === true,
  // E 只要求「卸载后的快照里目标已消失，且条目数回到基线」。
  // 起初我在这里多写了一条 `u.rev !== b.rev`，那是**错的**：rev 回到与基线相同恰恰说明
  // 图干净地复原了，把它当失败条件等于要求"卸载后图不能恢复原状"。已删除该条。
  E_targetDisappeared: u.hasTarget === false && u.count !== null && b.count !== null && u.count === b.count,
  F_countsRecorded: b.count !== null && m.count !== null && u.count !== null,
}
out.counts = { baseline: b.count, afterMount: m.count, afterUnmount: u.count }

if (out.assertions.A_pidUnchanged === false) out.verdict.push('✘ dsh 进程已不是原来那个 PID —— 发生了重启，本实验无效')
if (out.assertions.B_pluginMounted !== true) out.verdict.push('✘ 插件宿主半没有装载（ping 不 ok）—— 先排查插件装载，再谈热装载')
if (out.assertions.C_entryCountGrew === true) out.verdict.push(`★ 热装载：客户端模块图条目数 ${String(b.count)} → ${String(m.count)}，进程 PID 未变 —— 运行树里真的多了一个条目`)
else out.verdict.push(`（未观察到条目数增加：${String(b.count)} → ${String(m.count)}；见 mount 返回体）`)
if (out.assertions.D_targetAppeared === true) out.verdict.push('★ 目标包名出现在装载后的快照里 —— 客户端模块系统已把它纳入可服务图（浏览器半可被加载）')
if (out.assertions.E_targetDisappeared === true) out.verdict.push(`★ 热卸载：卸载后的快照条目数回到 ${String(u.count)} 且目标包名消失`)
else out.verdict.push('（卸载后目标包名仍可见或快照未取到 —— 见 unmount 返回体里的尝试记录）')

console.log('\n===== H1 RESULT (JSON) =====')
console.log(JSON.stringify(out, null, 2))

/** 检查某个 PID 是否仍存在（`kill 0` 探测；EPERM 说明进程在但无权限，也算活着）。 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}
