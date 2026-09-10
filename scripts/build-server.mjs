#!/usr/bin/env node
/**
 * 打包后端单文件产物 `apps/launcher/dist/server.mjs`，并把产品版本作为**编译期常量**注入。
 *
 * 唯一真源：仓库根 `package.json` 的 `version` 字段。
 * 注入的标识符 `__GODSH_VERSION__` 由 `packages/core/src/version.ts` 消费。
 *
 * 为什么必须用脚本而不是裸 esbuild CLI：
 * 历史事故（v0.6.1 安装包自报 0.5.5）的成因是 `config-store.ts` 里硬编码了旧版本，
 * 打包时被原样打进产物。改为「构建期注入 + 来源为根 package.json」后，
 * 只要根 package.json 正确，产物必然正确。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = rootPkg.version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[build-server] 根 package.json 的 version 非法或缺失: ${String(version)}`)
  process.exit(1)
}

const outfile = join(root, 'apps/launcher/dist/server.mjs')

await build({
  entryPoints: [join(root, 'apps/launcher/src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  define: { __GODSH_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
})

console.log(`[build-server] 产物: ${outfile}`)
console.log(`[build-server] 已注入 __GODSH_VERSION__ = ${version}`)
