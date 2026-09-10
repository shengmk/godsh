/**
 * 真实机器上的端到端验证（B1 兼容垫片 + B2 启动探活）。
 *
 * 为什么必须真机验证而不能只靠单测：
 * 单测用的是临时造的假依赖树与假 HTTP 服务；而这一轮修的两件事都**只在真实 dsh 上才会暴露**——
 * 依赖树不自洽是 npm 提升算法的产物，而「首个请求打死进程」需要真的向 dsh 发一个带
 * Accept-Encoding 的请求才能复现。所以这里：真树诊断 + 真树幂等 + 真起一个 dsh 实例再打它。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import {
  diagnoseDepTreeConsistency,
  shimNegotiatorContentType,
  collectContentTypeCandidates,
  readPkgVersion,
} from '../packages/core/src/dsh-heal.js'
import { probeWebUrl } from '../packages/core/src/process-manager.js'

const appData = process.env.APPDATA ?? ''
const dshRoot = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const dshNm = join(dshRoot, 'node_modules')
const topPkg = join(dshNm, 'content-type', 'package.json')
const nestedPkg = join(dshNm, 'negotiator', 'node_modules', 'content-type', 'package.json')

console.log('=== 1. 真实全局树的依赖自洽性诊断 ===')
const problems = diagnoseDepTreeConsistency(dshNm)
console.log('   问题数:', problems.length)
for (const p of problems) console.log('    -', p)

console.log('=== 2. 垫片在真实树上的幂等性（不得改动任何文件） ===')
const beforeTop = readFileSync(topPkg, 'utf8')
const beforeNested = existsSync(nestedPkg) ? readFileSync(nestedPkg, 'utf8') : null
const cands = collectContentTypeCandidates('web')
const existing = cands.filter((c) => existsSync(join(c, 'package.json')))
console.log('   候选位置:', cands.length, '/ 实际存在:', existing.length)
for (const c of existing) console.log('    -', readPkgVersion(c), c)
const applied = shimNegotiatorContentType(dshNm, cands)
const afterTop = readFileSync(topPkg, 'utf8')
const afterNested = existsSync(nestedPkg) ? readFileSync(nestedPkg, 'utf8') : null
console.log('   施加垫片数:', applied, '（已自洽时应为 0）')
console.log('   顶层 content-type 未变:', beforeTop === afterTop)
console.log('   嵌套副本未变:', beforeNested === afterNested)
console.log('   解析点版本:', readPkgVersion(join(dshNm, 'content-type')), '->', readPkgVersion(join(dshNm, 'negotiator', 'node_modules', 'content-type')))

/** 用指定的 Accept-Encoding 打一次请求（探活函数固定用浏览器那一组，这里要覆盖另外两组）。 */
function rawProbe(url: string, acceptEncoding: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolveProbe) => {
    const u = new URL(url)
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'accept-encoding': acceptEncoding, accept: 'text/html' },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolveProbe(`HTTP ${res.statusCode}`))
      }
    )
    req.on('timeout', () => {
      resolveProbe('超时')
      try {
        req.destroy()
      } catch {}
    })
    req.on('error', (e: Error) => resolveProbe(`连接失败: ${e.message}`))
    req.end()
  })
}

console.log('=== 3. 真起一个 dsh 实例，再用致死后端的头部去打它 ===')
const port = 3231
const child = spawn(
  process.execPath,
  [join(dshRoot, 'lib', 'bin.js'), '--profile', 'webtest', '--port', String(port), '--no-open'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
)
let childLog = ''
child.stdout?.on('data', (b: Buffer) => {
  childLog += String(b)
})
child.stderr?.on('data', (b: Buffer) => {
  childLog += String(b)
})
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break
    const r = await probeWebUrl(`http://127.0.0.1:${port}/`, 1500)
    if (r.ok) {
      ready = true
      console.log('   实例就绪，首次探活:', JSON.stringify(r))
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!ready) {
    console.log('   实例未就绪，进程退出码:', child.exitCode, '—— 后续验证跳过')
  } else {
    // 带 token 的地址才能拿到 200（可压缩的 HTML 响应必然穿过出事的 gzip 中间件）；
    // 不带 token 的 404 也可能绕过压缩路径，所以两种都打。
    const m = /dsh web:\s*(https?:\/\/[^\s]+)/.exec(childLog)
    const authUrl = m ? m[1]!.replace(/[),;]+$/, '') : null
    console.log('   日志里的认证地址:', authUrl ? '已取到' : '未取到')
    const targets: Array<[string, string]> = [
      ['带 token（期望 200，必经 gzip）', authUrl ?? `http://127.0.0.1:${port}/`],
      ['不带 token（期望 404/401）', `http://127.0.0.1:${port}/`],
    ]
    for (const [label, target] of targets) {
      console.log(`   ${label}`)
      for (const enc of ['gzip, deflate, br', 'gzip, deflate, br, zstd', 'gzip;q=1.0, identity;q=0.5, *;q=0']) {
        console.log(`     ${enc}`)
        console.log(`       -> ${await rawProbe(target, enc)}`)
      }
    }
    console.log('   六连打之后进程存活:', child.exitCode === null)
    console.log('   probeWebUrl 复查:', JSON.stringify(await probeWebUrl(authUrl ?? `http://127.0.0.1:${port}/`)))
    const crashed = /invalid media type|TypeError/i.test(childLog)
    console.log('   子进程日志里出现崩溃痕迹:', crashed)
  }
} finally {
  try {
    child.kill()
  } catch {
    /* 已退出 */
  }
  console.log('   实例已关闭')
}
