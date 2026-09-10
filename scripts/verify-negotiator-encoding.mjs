/**
 * 直接调用 dsh gzip 中间件出事的那一行代码路径，确认它现在不再抛错。
 *
 * 为什么这一条比"起个服务看 200"更直接：事故的崩溃栈最后落在
 * `WebServer.gzip (dsh-host-webserver/lib/index.js:122)` 里的
 * `new Negotiator(req).encodings()` —— 这里就是复刻那一行，
 * 用 dsh 安装目录里**真实的 negotiator 模块**，对九种 Accept-Encoding 逐一调用。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** content-type@2.x 的 exports 不暴露 ./package.json，只能从入口文件向上找包根。 */
function pkgRootOf(entryFile) {
  let d = dirname(entryFile)
  for (let i = 0; i < 8; i++) {
    const p = join(d, 'package.json')
    if (existsSync(p)) return { dir: d, pkg: JSON.parse(readFileSync(p, 'utf8')) }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

const dshRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const require = createRequire(join(dshRoot, 'noop.js'))

const negotiatorPath = require.resolve('negotiator', { paths: [join(dshRoot, 'node_modules')] })
const Negotiator = require(negotiatorPath)
// content-type@2.x 的 exports 不暴露 ./package.json，版本号只能从包根读
const ctPath = require.resolve('content-type', { paths: [join(dshRoot, 'node_modules', 'negotiator')] })
const ctRoot = pkgRootOf(ctPath)

console.log('negotiator 实际加载自:', negotiatorPath)
console.log('negotiator 解析到的 content-type:', ctPath)
console.log('content-type 版本:', ctRoot ? ctRoot.pkg.version : '读不到')
console.log('')

const cases = [
  'gzip, deflate, br',
  'gzip, deflate, br, zstd',
  'gzip',
  'br',
  '*',
  'identity',
  'zh-CN',
  'gzip;q=1.0, identity;q=0.5, *;q=0',
  '',
]

let crashed = 0
for (const enc of cases) {
  const label = enc === '' ? '(空串)' : enc
  try {
    const n = new Negotiator({ headers: enc === '' ? {} : { 'accept-encoding': enc } })
    const out = n.encodings()
    console.log(`  OK    ${label.padEnd(38)} -> ${JSON.stringify(out)}`)
  } catch (e) {
    crashed++
    console.log(`  崩溃  ${label.padEnd(38)} -> ${e.constructor.name}: ${e.message}`)
  }
}
console.log('')
console.log(crashed === 0 ? `全部 ${cases.length} 种输入均未抛错（修复有效）` : `有 ${crashed} 种输入仍然抛错`)
process.exit(crashed === 0 ? 0 : 1)
