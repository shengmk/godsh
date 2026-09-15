/**
 * 「可写进 `dsh.profile.bundles` 的 bundle」的**唯一判据**。
 *
 * 缺陷背景（用户可见症状：每次插件注入后都必须先启用自愈，环境才打得开）
 * ------------------------------------------------------------------
 * `dsh.profile.bundles` 里的每一项都被 dsh 当作**patch 层**装载。dsh 侧的要求见
 * `@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory`：先解析包目录，再读该包
 * `package.json` 的 `dsh.bundle.patch`；取不到 `patch`（undefined）就直接抛
 *
 *     ${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json
 *
 * 即**环境打不开**。而 godsh 原先两处门禁（插件门控 `deployToProfile` 与启动门禁
 * `runPreflightCheck`）都只验「包目录在不在」。二者**不等价**：能解析但并非 bundle 的
 * 普通插件会被写进 bundles，dsh 随即硬失败；用户唯一出路是跑一次自愈。本模块把两侧
 * 收敛到同一个判据实现上。
 *
 * 判据（三条同时成立才可写入）
 * ---------------------------
 *  1. **物理可解析**：`lstat` + `realpath` 验真。**绝不使用 `existsSync`** —— 它只回答
 *     「这个路径能不能 stat 到」，给不出真实目标，在断链 junction 上无法区分「目标被删」
 *     与「一开始就不存在」；本项目纪律见 `vault-atomic.test.ts` 的 `assertResolvablePackage`。
 *  2. 该包 `package.json` 声明了**字符串型且非空**的 `dsh.bundle.patch`。
 *  3. **不是官方包**（{@link isOfficialPackage}）：godsh 不写入官方资产；官方 bundle 由 dsh
 *     从安装目录自带解析，本来就不需要出现在 profile 的 bundles 里。
 *
 * 解析范围（**已知边界**）
 * ----------------------
 * 判据 1 只认 `<profileDir>/node_modules/<name>` 这一个锚点。dsh 自身有**两个**锚点
 * （先安装目录、再 profile 目录），因此「只有装进 dsh 安装目录才算可解析的非官方包」会被
 * 本判据判为不可装载。官方包由判据 3 豁免，社区包经 godsh 注入后必然在 profile 内，
 * 故实际不受影响；这一边界是刻意的（保持与旧门禁相同的解析范围，只收紧判据），不做静默扩张。
 *
 * @module @godsh/core/profile-bundle
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isOfficialPackage } from './dsh-official.js'

/** 单个 bundle 项的判定状态。 */
export type ProfileBundleStatus =
  /** 可写入门控，且 dsh 能把它当 patch 层装载（三条判据全过）。 */
  | 'loadable'
  /** 官方包：豁免。dsh 从安装目录自带解析，godsh 既不写入也不该修剪。 */
  | 'official'
  /** 物理不可解析：目录不存在、或链接已断（realpath 抛 ENOENT）。 */
  | 'unresolvable'
  /** 物理可解析，但 `package.json` 未声明字符串型 `dsh.bundle.patch` —— dsh 会硬失败。 */
  | 'no-bundle-manifest'

/** 一次 bundle 项判定的完整结论。 */
export interface ProfileBundleInspection {
  /** 被检查的包名（来自 `dsh.profile.bundles`）。 */
  name: string
  /** 判定状态。 */
  status: ProfileBundleStatus
  /** `lstat` + `realpath` 出来的真实包目录；不可解析时为 `null`。 */
  dir: string | null
  /**
   * 门控口径：**可以**把该名字写进 `dsh.profile.bundles`。
   * 当且仅当 `status === 'loadable'`。
   *
   * 官方包这里是 `false` —— 不是因为 dsh 装载不了（dsh 从安装目录解析得到它），
   * 而是因为 godsh 不该把官方资产写进 bundles。需要「保留既有官方条目」的修剪口径
   * 请用 {@link isRetainableProfileBundle}。
   */
  loadable: boolean
  /** 中文诊断原因（含包名与缺失字段名）；`loadable` / `official` 时为 `null`。 */
  problem: string | null
}

/**
 * 包名是否可以安全地拼进 `node_modules` 路径。
 *
 * 只拒「一定不是合法包名、且可能造成目录穿越」的形态（空段、`.`、`..`、反斜杠、NUL）。
 * 刻意**不**强制 npm 的 1 段 / 2 段规则：那会把畸形但无害的名字误判为穿越，反而扩大影响面。
 */
function hasUnsafeSegment(name: string): boolean {
  if (typeof name !== 'string' || name === '') return true
  return name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0'))
}

/**
 * 解析 profile 里某包的真实物理目录（`lstat` → `realpath` → 真读文件口径）。
 *
 * 返回 `null` 即「物理不可解析」：路径不存在、断链 junction/symlink、权限错误、
 * 或包目录下没有 `package.json` 这个**普通文件**。
 *
 * 为什么不用 `existsSync`：本项目已实测 Node v25.8.0 / win32 下断链 junction 的
 * `existsSync` 返回 `false`，与「真实可解析」的行为不一致；而 `lstat` + `realpath`
 * 在两种行为下都成立（`realpath` 对断链直接抛 ENOENT），是唯一无歧义的口径。
 *
 * @param profileDir - profile 目录（其下应有 `node_modules`）。
 * @param name - 包名。
 * @returns 真实包目录（绝对路径），或 `null`。
 */
export function resolveProfilePackageDir(profileDir: string, name: string): string | null {
  if (hasUnsafeSegment(name)) return null
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  try {
    lstatSync(dir) // 路径不存在 → 抛错
    const real = realpathSync(dir) // 断链（目标被删 / 一开始就不存在）→ 抛 ENOENT
    if (!lstatSync(join(real, 'package.json')).isFile()) return null
    return resolve(real)
  } catch {
    return null
  }
}

/** 读取某包目录声明的 `dsh.bundle.patch`；缺失 / 非字符串 / 空串 / JSON 坏一律视为未声明。 */
function readDeclaredBundlePatch(dir: string): { ok: true; patch: string } | { ok: false } {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const patch = manifest.dsh?.bundle?.patch
    // dsh 只判 `=== undefined`，但 `patch: null` 会让它随后 `join(dir, null)` 抛 TypeError，
    // 空串会让它去读目录本身：对 godsh 而言这三种都等于「不能作为 bundle 装载」，一律拒绝。
    if (typeof patch !== 'string' || patch === '') return { ok: false }
    return { ok: true, patch }
  } catch {
    return { ok: false }
  }
}

/**
 * 判定 `dsh.profile.bundles` 里的一个条目能否作为 bundle 装载。
 *
 * 这是本模块的**唯一判据实现**；{@link isLoadableProfileBundle} 与
 * {@link isRetainableProfileBundle} 只是它的两种口径包装，不再各自重写判定。
 *
 * @param profileDir - profile 目录。
 * @param name - 条目里的包名。
 * @returns 判定结论（含中文原因）。
 */
export function inspectProfileBundle(profileDir: string, name: string): ProfileBundleInspection {
  if (isOfficialPackage(name)) {
    return { name, status: 'official', dir: null, loadable: false, problem: null }
  }

  const dir = resolveProfilePackageDir(profileDir, name)
  if (dir === null) {
    return {
      name,
      status: 'unresolvable',
      dir: null,
      loadable: false,
      problem: `${name}：在环境的 node_modules 下无法解析到该包（目录不存在，或 junction/软链已断）`,
    }
  }

  if (!readDeclaredBundlePatch(dir).ok) {
    return {
      name,
      status: 'no-bundle-manifest',
      dir,
      loadable: false,
      problem: `${name}：该包 package.json 未声明字符串型 dsh.bundle.patch，dsh 无法把它当作 patch 层装载`,
    }
  }

  return { name, status: 'loadable', dir, loadable: true, problem: null }
}

/** 门控口径：能否把该名字写进 `dsh.profile.bundles`（三条判据全过）。 */
export function isLoadableProfileBundle(profileDir: string, name: string): boolean {
  return inspectProfileBundle(profileDir, name).loadable
}

/**
 * 修剪口径：**保留**既有条目还是剔除。
 *
 * 与门控口径的唯一差别是官方包：dsh 从安装目录解析它们，godsh 既不写入、也不该把
 * 历史遗留的官方条目当作「坏条目」删掉。
 */
export function isRetainableProfileBundle(profileDir: string, name: string): boolean {
  const verdict = inspectProfileBundle(profileDir, name)
  return verdict.status === 'official' || verdict.loadable
}

/**
 * 启动门禁：列出 `dsh.profile.bundles` 中**无法作为 bundle 装载**的条目。
 *
 * 与插件门控 `deployToProfile` 共用 {@link inspectProfileBundle}，因此两侧判据恒等：
 * 门控不会写进去的东西，门禁也一定能报出来。
 *
 * @param dshHome - DSH 家目录（其下有 `profiles/`）。
 * @param profileName - profile 名。
 * @returns 不可装载条目的判定结论；`package.json` 不可读时返回空数组（由其它层负责报错）。
 */
export function findUnloadableProfileBundles(dshHome: string, profileName: string): ProfileBundleInspection[] {
  const profileDir = join(dshHome, 'profiles', profileName)
  let bundles: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const raw = pkg.dsh?.profile?.bundles
    if (Array.isArray(raw)) bundles = raw.filter((x): x is string => typeof x === 'string')
  } catch {
    return [] // package.json 不可读 / 不存在由其它层负责报错
  }
  return bundles.map((name) => inspectProfileBundle(profileDir, name)).filter((v) => v.status !== 'loadable' && v.status !== 'official')
}

/**
 * 把不可装载条目渲染成用户可读的中文原因（点名包名与缺失字段 `dsh.bundle.patch`）。
 *
 * @param issues - {@link findUnloadableProfileBundles} 的结果。
 * @returns 多行中文说明；`issues` 为空时返回空串。
 */
export function describeUnloadableBundles(issues: ProfileBundleInspection[]): string {
  if (issues.length === 0) return ''
  const lines = issues.map((i) => `  • ${i.problem ?? i.name}`)
  return [
    '以下包被列在 dsh.profile.bundles 中，但 dsh 无法把它们当作 patch 层装载（启动会失败）：',
    ...lines,
    '补救：在环境详情里卸载这些插件（会同时把条目从 dsh.profile.bundles 移除）后再启动。',
  ].join('\n')
}
