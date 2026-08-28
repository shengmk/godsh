import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件位于 <root>/packages/core/src/paths.ts（源码运行时）
const here = dirname(fileURLToPath(import.meta.url)) // packages/core/src

/**
 * dsh-launcher 工作区根目录。
 * 打包成单文件后 `import.meta.url` 指向产物而非源码，因此允许用
 * `DSH_LAUNCHER_ROOT` 显式指定根目录（Tauri 侧启动后端时传入）。
 */
export const MONOREPO_ROOT = process.env.DSH_LAUNCHER_ROOT
  ? resolve(process.env.DSH_LAUNCHER_ROOT)
  : resolve(here, '..', '..', '..')

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
