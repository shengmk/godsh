#!/usr/bin/env node
/**
 * `@godsh/dsh` 双面包的构建脚本。
 *
 * 为什么必须是脚本而不是裸 esbuild CLI
 * ----------------------------------
 * 浏览器半的产物格式是 dsh 客户端模块系统的**硬契约**：一个自注册的 IIFE
 *   `window.__ModuleLoader__.load({ id, factory })`
 * 其中 `factory` 是 CJS 语义（`factory(require) -> module.exports`）。
 * dsh 的 `ClientModuleSystem` 在「注册 → 首次 import 时才 materialize」两段式上跑
 * （见 `dsh-client-modules/lib/client.js` 的 `register` / `materialize`），
 * 所以产物必须正好是这个形状 —— 手工包一层比让人记住 CLI 参数可靠。
 *
 * 三条必须守住的纪律
 * ----------------
 *  1. **React 是外部依赖**：`react` / `react-dom` / `react/jsx-runtime` 一律 external。
 *     浏览器侧只允许存在一份 React（由平台 seed 提供）；把 React 打进 bundle 会让
 *     组件树里出现第二个 React 实例，hooks 立刻报错。这也是 dsh 客户端 bundle 的既成规矩。
 *  2. **宿主半零外部依赖**：宿主半只用 node 内置 + 注入进来的服务，产物里不应出现任何
 *     `@deepseek-ai/*`（我们连类型都是自己声明的）。打完断言一次，防止将来误加 import。
 *  3. **产物必须先建再用**：`exports` 指向 `lib/*.js`，没有 lib 就装不上；
 *     本项目在参考插件上见过「测试在 build 之前跑 → 静默跳过产物护栏」的假阴性，
 *     因此本脚本打完会自检产物存在与形状。
 *
 * 用法：node packages/dsh-godsh-plugin/scripts/build.mjs
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const libDir = join(pkgRoot, 'lib')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

mkdirSync(libDir, { recursive: true })

// ---------- 1) 宿主半：ESM，零外部依赖 ----------
const hostOut = join(libDir, 'index.js')
await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  outfile: hostOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // 宿主半边不 import 任何 @deepseek-ai/*（服务都是运行时 ctx.get 拿的），
  // 但仍显式 external 一遍：将来若有人加了 import，这里会立刻暴露成"未打包进来的裸 import"，
  // 而不是把官方包的一份副本打进产物（那会造成两份实例）。
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})

// ---------- 2) 浏览器半：CJS → 包成 __ModuleLoader__.load ----------
const clientEntry = join(pkgRoot, 'src/client/index.ts')
const clientBuilt = await build({
  entryPoints: [clientEntry],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  write: false,
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'warning',
})

const cjs = clientBuilt.outputFiles?.[0]?.text
if (typeof cjs !== 'string' || cjs === '') {
  console.error('[build-godsh-plugin] 浏览器半构建没有产出内容')
  process.exit(1)
}

// 自注册包装：与 dsh-client-hmr 的产物逐字同构（module/exports 显式建立，
// 因为 factory 拿到的是 require，而不是 node 的模块外壳）
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${cjs
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
    return module.exports;
  }
});
`
const clientOut = join(libDir, 'client.js')
writeFileSync(clientOut, wrapped, 'utf8')

// ---------- 3) 产物自检（不是"打完就算"，而是断言契约成立） ----------
const problems = []

const hostText = readFileSync(hostOut, 'utf8')
if (!/export\s*\{[^}]*\bname\b/.test(hostText) && !/export\s+const\s+name\b/.test(hostText)) {
  problems.push('宿主半产物里看不到导出 name —— patch 行的 id 会对不上')
}
if (/from\s*"@deepseek-ai\//.test(hostText)) {
  problems.push('宿主半产物里出现了对 @deepseek-ai/* 的裸 import —— 会被打成两份实例')
}
if (/"godsh"/.test(hostText) === false) {
  problems.push('宿主半产物里找不到插件名 "godsh"')
}

const clientText = readFileSync(clientOut, 'utf8')
if (!clientText.includes('window.__ModuleLoader__.load(')) {
  problems.push('浏览器半产物没有 __ModuleLoader__.load 自注册外壳')
}
if (!clientText.includes(`id: ${JSON.stringify(pkg.name)}`)) {
  problems.push(`浏览器半产物的 id 不等于包名 ${pkg.name}`)
}
if (!/\bfactory\s*:/.test(clientText)) {
  problems.push('浏览器半产物缺少 factory')
}
// 反例护栏：React 必须是外部 require 而不是被打进来的实现
if (clientText.includes('react-dom.development.js') || /Symbol\.for\("react\.element"\)/.test(clientText)) {
  problems.push('浏览器半把 React 打进了产物 —— 会出现第二个 React 实例')
}

if (problems.length > 0) {
  console.error('[build-godsh-plugin] 产物自检失败：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`[build-godsh-plugin] 宿主半 → ${hostOut}`)
console.log(`[build-godsh-plugin] 浏览器半 → ${clientOut}（${String(Buffer.byteLength(clientText))} 字节，自注册外壳 + React external 已断言）`)
