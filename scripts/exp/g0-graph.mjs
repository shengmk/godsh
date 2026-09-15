#!/usr/bin/env node
/**
 * 抓一次 `/plugins/events` 的 graph 帧，报告客户端模块图的**条目数与是否含目标包**。
 *
 * 用途：作为 G0/G1 的「图是否变化」判据 —— 比 GET / 更可靠，因为：
 *   - SSE 用的是 dsh 自己的推送通道（HTTP 200 已验证可用）；
 *   - graph 帧里带 `rev` 与完整 `entries[]`，可直接 diff 出「新 row 是否进入图」。
 *
 * 用法：node scripts/exp/g0-graph.mjs --port 4864 --token <token> [--expect <pkg>] [--wait 6000]
 */

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const PORT = Number(arg('port', '4864'))
const TOKEN = arg('token', '')
const EXPECT = arg('expect', '')
const WAIT = Number(arg('wait', '6000'))

const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
const headers = { Accept: 'text/event-stream', ...(TOKEN ? { 'x-dsh-token': TOKEN } : {}) }

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), WAIT)

const frames = []
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/plugins/events${q}`, { headers, signal: controller.signal })
  console.log(`SSE 状态: ${res.status}`)
  if (res.ok && res.body !== null) {
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
        try {
          frames.push(JSON.parse(data))
        } catch {
          /* ignore */
        }
      }
    }
  }
} catch {
  /* abort 属正常结束路径 */
} finally {
  clearTimeout(timer)
}

const graphs = frames.filter((f) => f?.type === 'graph')
for (const g of graphs) {
  const entries = g.graph?.entries ?? []
  const ids = entries.map((e) => e.id)
  const hasExpect = EXPECT !== '' && ids.includes(EXPECT)
  console.log(
    `graph 帧: rev=${g.graph?.rev} entries=${entries.length} 含${EXPECT || '(未指定)'}=${hasExpect}`
  )
  if (EXPECT !== '') {
    const near = ids.filter((i) => i.includes(EXPECT.split('/').pop() ?? ''))
    console.log(`  近似匹配: ${near.length === 0 ? '无' : near.join(', ')}`)
  }
}
if (graphs.length === 0) console.log('未收到 graph 帧')
console.log(`其它帧类型: ${[...new Set(frames.map((f) => f?.type))].join(', ') || '无'}`)
