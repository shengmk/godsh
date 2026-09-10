#!/usr/bin/env node
/**
 * 版本一致性守卫（对应修复方案 §2.3 步骤 6）。
 *
 * 唯一真源（SSOT）= 仓库根 `package.json` 的 `version`。
 * 本脚本在 CI / 本地发版前断言：所有「机器可判定」的版本声明与产物都与 SSOT 一致，
 * 从机制上防止 v0.6.1 安装包自报 0.5.5 这类事故复发。
 *
 * 检查项：
 *  A. 各 package.json / Cargo.toml / tauri.conf.json 的 version === SSOT（硬失败）
 *  B. 后端产物中的 launcher.version 与 godshVersion === SSOT（硬失败，若产物存在）
 *  C. 两个历史事故点的源码不得再出现硬编码产品版本（硬失败）
 *  D. README.md 的「当前版本」声明 === SSOT（硬失败）
 *
 * 用法：node scripts/verify-version.mjs
 * 退出码：0 一致；1 有不一致。
 *
 * 注意：**不**检查历史文档（docs/、CHANGELOG 旧条目、.jspace 历史记录）与第三方版本
 * （data/cache/market.json、data/vault.json、示例插件 plugins/hello-world 等）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const ssot = readJson(join(root, 'package.json')).version
if (typeof ssot !== 'string' || !ssot) {
  console.error('✗ 无法从根 package.json 读取 version')
  process.exit(1)
}

const findings = []
const fail = (where, msg) => findings.push(`${where}: ${msg}`)
const rel = (p) => p.slice(root.length + 1)

/* ---------- A. 包与构建配置 ---------- */
const pkgTargets = [join(root, 'package.json')]
for (const group of ['apps', 'packages']) {
  const base = join(root, group)
  if (!existsSync(base)) continue
  for (const name of readdirSync(base)) {
    const p = join(base, name, 'package.json')
    if (existsSync(p)) pkgTargets.push(p)
  }
}
for (const p of pkgTargets) {
  const v = readJson(p).version
  if (v !== ssot) fail(rel(p), `version=${String(v)}，期望 ${ssot}`)
}

const cargo = join(root, 'apps/launcher/src-tauri/Cargo.toml')
if (existsSync(cargo)) {
  // 只取 [package] 段顶层的 version = "x.y.z"（行首无缩进）
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(cargo, 'utf8'))
  if (!m) fail('apps/launcher/src-tauri/Cargo.toml', '未找到 version 字段')
  else if (m[1] !== ssot) fail('apps/launcher/src-tauri/Cargo.toml', `version=${m[1]}，期望 ${ssot}`)
}

const tauriConf = join(root, 'apps/launcher/src-tauri/tauri.conf.json')
if (existsSync(tauriConf)) {
  const v = readJson(tauriConf).version
  if (v !== ssot) fail('apps/launcher/src-tauri/tauri.conf.json', `version=${String(v)}，期望 ${ssot}`)
}

/* ---------- B. 后端产物（真正的「已发布内容」） ---------- */
const artifacts = [
  join(root, 'apps/launcher/dist/server.mjs'),
  join(root, 'apps/launcher/src-tauri/resources/server.mjs'),
]
for (const art of artifacts) {
  if (!existsSync(art)) continue
  const text = readFileSync(art, 'utf8')
  const launcher = /launcher:\s*\{\s*name:\s*"godsh",\s*version:\s*"([^"]+)"/.exec(text)
  if (launcher && launcher[1] !== ssot) {
    fail(rel(art), `产物内 launcher.version=${launcher[1]}，期望 ${ssot}（请执行 pnpm build:server 重新打包）`)
  }
  const snap = /godshVersion:\s*"([^"]+)"/.exec(text)
  if (snap && snap[1] !== ssot) {
    fail(rel(art), `产物内 godshVersion=${snap[1]}，期望 ${ssot}`)
  }
}

/* ---------- C. 历史事故点：源码不得再硬编码产品版本 ---------- */
const hardcodeGuards = [
  ['packages/core/src/config-store.ts', /version:\s*'\d+\.\d+\.\d+'/, 'launcher.version 必须来自 APP_VERSION'],
  ['packages/dsh-plugin/src/backup-manager.ts', /godshVersion:\s*'\d+\.\d+\.\d+'/, 'godshVersion 必须来自 APP_VERSION'],
  ['packages/dsh-plugin/src/client/drawer.ts', /v\d+\.\d+\.\d+\s*原生版/, 'UI 徽章版本必须来自 APP_VERSION'],
]
for (const [file, re, hint] of hardcodeGuards) {
  const p = join(root, file)
  if (!existsSync(p)) continue
  const m = re.exec(readFileSync(p, 'utf8'))
  if (m) fail(file, `仍存在硬编码版本 "${m[0].trim()}"：${hint}`)
}

/* ---------- D. README 门面 ---------- */
const readme = join(root, 'README.md')
if (existsSync(readme)) {
  const m = /当前版本[：:]\s*\*\*v([\d.]+)\*\*/.exec(readFileSync(readme, 'utf8'))
  if (!m) fail('README.md', '未找到「当前版本：**vX.Y.Z**」声明')
  else if (m[1] !== ssot) fail('README.md', `当前版本=v${m[1]}，期望 v${ssot}`)
}

/* ---------- 输出 ---------- */
if (findings.length > 0) {
  console.error(`verify-version: ${findings.length} 处不一致（SSOT = ${ssot}）`)
  for (const f of findings) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`verify-version: 全部一致（SSOT = ${ssot}）`)
