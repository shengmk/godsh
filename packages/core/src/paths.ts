import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 源码运行时本文件位于 <root>/packages/core/src/paths.ts；
// 打包成单文件后 `import.meta.url` 指向产物（安装布局里是 <安装目录>/resources/server.mjs）。
const here = dirname(fileURLToPath(import.meta.url))

/** 该目录是否为本仓库根：用根 package.json 的 name 作为标记，避免把任意上溯目录当成仓库根。 */
function looksLikeRepoRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return pkg.name === 'godsh'
  } catch {
    return false
  }
}

/**
 * godsh 工作区根目录。
 *
 * - **源码运行**（`tsx` / `tsc` / `apps/launcher/dist/server.mjs`）：`here` 指向 `packages/core/src`
 *   或 `apps/launcher/dist`，上溯三级正好是仓库根，能读到 name 为 `godsh` 的根 `package.json`。
 * - **打包运行**（`<安装目录>/resources/server.mjs`）：上溯三级会落到安装目录**之外**
 *   （例：`%LOCALAPPDATA%\godsh\resources` 上溯三级 = `%LOCALAPPDATA%`），那里没有本仓库的
 *   `package.json`。实测（?02）该目录会被当成根，使 `plugins/`、`kernels/instances/` 解析到
 *   安装目录之外的无关位置。因此这种情况下改用「产物所在目录」（即 `resources/`）作为根，
 *   与 `server.ts` 中前端 distDir 的 `与 server.mjs 同级` 兜底、以及 Rust 侧
 *   `resolve_resource` 的资源布局保持一致。
 * - `DSH_LAUNCHER_ROOT` 显式指定时最高优先（Tauri 侧可传入）。
 */
export const MONOREPO_ROOT = (() => {
  if (process.env.DSH_LAUNCHER_ROOT) return resolve(process.env.DSH_LAUNCHER_ROOT)
  const upThree = resolve(here, '..', '..', '..')
  return looksLikeRepoRoot(upThree) ? upThree : here
})()

/** Launcher 数据目录（config/kernels/allocations/logs；可用 DSH_LAUNCHER_DATA_DIR 覆盖为用户级目录）。 */
export const DATA_DIR = process.env.DSH_LAUNCHER_DATA_DIR
  ? resolve(process.env.DSH_LAUNCHER_DATA_DIR)
  : resolve(MONOREPO_ROOT, 'data')

/** 本地插件源码目录（plugins/）。 */
export const PLUGINS_DIR = resolve(MONOREPO_ROOT, 'plugins')

/** 本地内核模板目录（kernels/templates/；可用 DSH_LAUNCHER_TEMPLATES_DIR 覆盖为资源目录）。 */
export const KERNEL_TEMPLATES_DIR = process.env.DSH_LAUNCHER_TEMPLATES_DIR
  ? resolve(process.env.DSH_LAUNCHER_TEMPLATES_DIR)
  : resolve(MONOREPO_ROOT, 'kernels', 'templates')

/** 内核实例配置目录（kernels/instances/）。 */
export const KERNEL_INSTANCES_DIR = resolve(MONOREPO_ROOT, 'kernels', 'instances')

/** 运行日志目录（data/logs/）。 */
export const LOGS_DIR = resolve(DATA_DIR, 'logs')
