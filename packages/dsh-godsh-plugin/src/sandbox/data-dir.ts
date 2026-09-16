/**
 * 沙箱数据目录的解析 —— 必须与 **godsh 启动器**用的是同一个目录。
 *
 * 为什么这是分部 G 的第一个必须解决的问题
 * --------------------------------------
 * `@godsh/dsh` 是跑在 **dsh 进程内**的插件，而沙箱（vault）的数据一直是 godsh 启动器
 * 在管的。如果插件自己猜一个目录，用户在 dsh 里的沙箱页看到的就会是**另一份空沙箱** ——
 * 那不是"在 dsh 里管沙箱"，那是"又造了一个沙箱"。
 *
 * 启动器侧的权威实现（逐字对照，不猜）：
 *   - `apps/launcher/src-tauri/src/lib.rs:48-54` 的 `data_dir()`：
 *       `DSH_LAUNCHER_DATA_DIR` 优先，否则 `%APPDATA%\godsh\data`
 *   - `apps/launcher/src/context.ts:64`：`new VaultManager(DATA_DIR)`
 *   - `packages/core/src/paths.ts:39-41`：`DATA_DIR = DSH_LAUNCHER_DATA_DIR || MONOREPO_ROOT/data`
 *
 * 需要留意的两处差异
 * ----------------
 *  1. **开发模式 vs 打包模式**：`DATA_DIR` 在仓库里跑时是 `<仓库>/data`，而打包运行时
 *     Rust 壳会把 `DSH_LAUNCHER_DATA_DIR` 设成 `%APPDATA%\godsh\data`。
 *     本模块**以环境变量优先**，因此两种形态都能对上：启动器怎么起，这里就跟着走。
 *  2. **`MONOREPO_ROOT/data` 这条路不能跟**：插件被打包进 dsh profile 后，
 *     `@godsh/core` 的 `MONOREPO_ROOT` 会退化成"产物所在目录"，`<插件 lib>/data` 毫无意义。
 *     所以这里**不**去读 `DATA_DIR`，而是自己按同一条优先级重算 —— 这是刻意的重复，
 *     因为那一个常量在宿主里必然算错。
 *
 * @module @godsh/dsh/sandbox/data-dir
 */

import { join, resolve } from 'node:path'

/** 解析所需的环境面（便于单测注入）。 */
export interface DataDirEnv {
  DSH_LAUNCHER_DATA_DIR?: string | undefined
  APPDATA?: string | undefined
  DSH_HOME?: string | undefined
  USERPROFILE?: string | undefined
  HOME?: string | undefined
}

/** 解析结果，带上"来源"，便于自检面板如实告诉用户这是哪一个目录、为什么。 */
export interface DataDirResolution {
  /** 绝对路径。 */
  dir: string
  /** 命中来源：`env` / `appdata` / `dsh-home` / `cwd-fallback`。 */
  from: 'env' | 'appdata' | 'dsh-home' | 'cwd-fallback'
  /** 人类可读的说明。 */
  reason: string
}

/**
 * 解析沙箱数据目录。
 *
 * 优先级（与 `lib.rs` 的 `data_dir()` 保持一致，只多了非 Windows 的兜底）：
 *  1. `DSH_LAUNCHER_DATA_DIR` —— 启动器显式指定（打包运行时就是这条）；
 *  2. `%APPDATA%\godsh\data` —— Windows 上启动器的默认值；
 *  3. `$DSH_HOME/godsh/data`（`DSH_HOME` 缺省为 `~/.dsh`）—— 非 Windows 或变量缺失时的兜底，
 *     仍然落在 dsh 自己的家目录下，不会污染系统目录。
 *
 * @param env - 环境变量面（默认 `process.env`）。
 * @param cwd - 最后的兜底基准目录（默认 `process.cwd()`）。
 * @returns 目录、来源与原因。
 */
export function resolveSandboxDataDir(env: DataDirEnv = process.env, cwd = process.cwd()): DataDirResolution {
  const fromEnv = env.DSH_LAUNCHER_DATA_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { dir: resolve(fromEnv), from: 'env', reason: '由 DSH_LAUNCHER_DATA_DIR 指定（启动器显式传入）' }
  }

  const appData = env.APPDATA
  if (typeof appData === 'string' && appData.trim() !== '') {
    return {
      dir: resolve(join(appData, 'godsh', 'data')),
      from: 'appdata',
      reason: '启动器的默认位置（%APPDATA%\\godsh\\data）',
    }
  }

  const dshHome = env.DSH_HOME ?? (env.USERPROFILE ?? env.HOME ? join(env.USERPROFILE ?? env.HOME ?? '', '.dsh') : '')
  if (dshHome !== '') {
    return {
      dir: resolve(join(dshHome, 'godsh', 'data')),
      from: 'dsh-home',
      reason: '无 APPDATA 时的兜底（$DSH_HOME/godsh/data）',
    }
  }

  return { dir: resolve(join(cwd, 'data')), from: 'cwd-fallback', reason: '环境变量全部缺失，退回当前工作目录' }
}
