import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * godsh 产品版本唯一真源（SSOT）。
 *
 * 设计目的：消灭「同一个版本号散落在 7 类文件里、靠人工脚本尽力同步」的历史问题。
 * 此前 `config-store.ts` 与 `backup-manager.ts` 各自硬编码了一个旧版本号字面量，
 * 导致新版安装包对外自报旧版本（`/api/health`、`/api/backup`、环境快照 `godshVersion`）。
 *
 * 取值优先级：
 *  1. `__GODSH_VERSION__` —— 由 `scripts/build-server.mjs` 在打包时经 esbuild `--define`
 *     注入，值直接来自**仓库根 `package.json` 的 `version`**（打包产物用这条）。
 *  2. 仓库根 `package.json` 的 `version` —— 源码直跑（`tsx` / `tsc`）时按相对路径读取。
 *     本文件位于 `<root>/packages/core/src/version.ts`，故上溯三级即仓库根。
 *  3. `'0.0.0-dev'` —— 仅在无法定位根 package.json 时兜底；它**不代表任何真实发布版本**，
 *     一旦出现即说明构建环境异常，请修环境而不是改这个常量。
 */
declare const __GODSH_VERSION__: string | undefined

function readRootPackageVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // packages/core/src
    const rootPkg = resolve(here, '..', '..', '..', 'package.json')
    const parsed = JSON.parse(readFileSync(rootPkg, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
  } catch {
    return null
  }
}

function resolveAppVersion(): string {
  if (typeof __GODSH_VERSION__ === 'string' && __GODSH_VERSION__.length > 0) {
    return __GODSH_VERSION__
  }
  return readRootPackageVersion() ?? '0.0.0-dev'
}

/** 当前产品版本。全仓唯一权威来源为根 `package.json` 的 `version`。 */
export const APP_VERSION: string = resolveAppVersion()
