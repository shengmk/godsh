/**
 * 沙箱条目的**真实来源**模型 —— 缺陷 3 前半（「沙箱不能全部更新」）的治本。
 *
 * 缺陷现状与根因（本项目实测）
 * --------------------------
 * `checkUpdates()` 只查 `p.source !== 'local'`，而 `updatePlugin()` 对
 * `source === 'local'` 直接抛错；但**收割入库一律写 `source: 'local'`**
 * （`id` 形如 `vault-harvested-*`）。于是：
 *
 *   - 沙箱主体是从环境反向收割来的（`source:'local'`）；
 *   - 更新器只认 npm 源（`source:'market'`）；
 *   - 两者交集为空 → **全量更新先天不可能更新任何收割插件**。
 *
 * 为什么 `source` 这个字段救不了
 * ----------------------------
 * `source: 'market' | 'local'` 是个**二值垃圾桶**：它把「从 npm 装的」「从 git 装的」
 * 「本地目录导入的」「从环境收割的」四类完全不同的东西压成同一个 `local`，
 * 而"能不能从 npm 更新"这件事需要的恰恰是这四类的区分。
 *
 * 本模块的做法
 * ----------
 * 用一个**可推断**的 `origin` 表达真实来源，并把「能否从 npm 自动更新」变成一条
 * 显式、可单测的判据（{@link isUpdatableEntry}），而不是散落在各处的 `source` 比较。
 *
 * **兼容历史数据**：`origin` 是可选字段，缺失时由 {@link inferVaultOrigin} 按既定规则推断
 * （推断是纯函数，不写盘、不产生副作用），因此不需要数据迁移就能让旧沙箱条目恢复可更新。
 *
 * @module @godsh/plugin-registry/vault-origin
 */

/** 沙箱条目的真实来源类别。 */
export type VaultOriginKind =
  /** 从 npm 安装（市场路径）。 */
  | 'npm'
  /** 从某个环境反向收割纳管：包名通常仍来自 npm，因此**可以**尝试从 npm 更新。 */
  | 'profile-harvest'
  /** 本地目录导入：没有远端，只能人工重新导入，**不参与**自动更新。 */
  | 'dir'
  /** 被两个及以上父共同占有而按父隔离的副本：**不参与**自更新（见下方说明）。 */
  | 'shared-copy'

/** 一条沙箱条目的来源。 */
export interface VaultOrigin {
  kind: VaultOriginKind
  /** 补充标识：收割时是源 profile 名；其余情形可留空。 */
  ref?: string
}

/** {@link inferVaultOrigin} 需要的最小字段面（只读，便于单测传轻量对象）。 */
export interface OriginCarrier {
  id: string
  source: 'market' | 'local'
  origin?: VaultOrigin
  childOrigin?: 'standalone' | 'shared-copy'
  installedProfiles?: string[]
}

/** 收割条目的 id 前缀（`harvestFromProfiles` 生成）。 */
export const HARVESTED_ID_PREFIX = 'vault-harvested-'

/**
 * 推断一条沙箱条目的来源。
 *
 * 规则（按优先级，先命中先返回）：
 *  1. 已显式记录 `origin` → 原样采用；
 *  2. `childOrigin === 'shared-copy'` → `shared-copy`；
 *  3. `id` 以 {@link HARVESTED_ID_PREFIX} 开头 → `profile-harvest`（`ref` 取第一个已装环境）；
 *  4. `source === 'market'` → `npm`；
 *  5. 其余 → `dir`（本地导入的兜底分类）。
 *
 * 顺序为什么是这样：`childOrigin` 是"这个副本归谁"的更强事实，比 `source` 更具体；
 * 而收割条目的 `id` 前缀是 `harvestFromProfiles` 自己写的、比 `source` 更精确，
 * 所以两者都排在 `source` 判断之前。
 *
 * @param p - 载体（只需 id / source / origin / childOrigin / installedProfiles）。
 * @returns 推断出的来源。
 */
export function inferVaultOrigin(p: OriginCarrier): VaultOrigin {
  if (p.origin !== undefined && p.origin.kind !== undefined) return p.origin
  if (p.childOrigin === 'shared-copy') return { kind: 'shared-copy' }
  if (typeof p.id === 'string' && p.id.startsWith(HARVESTED_ID_PREFIX)) {
    const ref = p.installedProfiles?.[0]
    return ref === undefined ? { kind: 'profile-harvest' } : { kind: 'profile-harvest', ref }
  }
  if (p.source === 'market') return { kind: 'npm' }
  return { kind: 'dir' }
}

/**
 * 该来源能否从 npm 自动更新。
 *
 * `npm` 与 `profile-harvest` 可以（后者的包名本身通常就来自 npm）；
 * `dir` 没有远端；`shared-copy` **不能** —— 这不是能力问题而是**隔离不变量的要求**：
 * `updatePlugin` 会把 `sourcePath` 指回池里按包名命名的**公共**目录 `<dep>@<ver>`，
 * 于是两个父的副本又会指向同一条物理路径，按父隔离的前提当场失效
 * （之后删掉任何一个父都会连带毁掉另一个父的依赖）。这条限制在 `vault.ts` 里已有记载。
 *
 * @param origin - 来源。
 * @returns 可自动更新时为 `true`。
 */
export function isNpmUpdatable(origin: VaultOrigin): boolean {
  return origin.kind === 'npm' || origin.kind === 'profile-harvest'
}

/** 中文来源标签（诊断与界面文案用）。 */
export function originLabel(origin: VaultOrigin): string {
  switch (origin.kind) {
    case 'npm':
      return 'npm 包'
    case 'profile-harvest':
      return origin.ref === undefined ? '自环境收割' : `自环境收割（源：${origin.ref}）`
    case 'dir':
      return '本地目录导入'
    case 'shared-copy':
      return '共同占有的按父隔离副本'
  }
}

/**
 * 沙箱条目能否参与「从 npm 自动更新」的**唯一判据**。
 *
 * 把 `childOrigin` 的排除也收在这里，是为了让「更新器包含谁」只有一个实现 ——
 * 原先这条排除散在 `checkUpdates` 与 `updateAll` 两处各写一遍，容易漏。
 *
 * @param p - 沙箱条目。
 * @returns 可参与自动更新时为 `true`。
 */
export function isUpdatableEntry(p: OriginCarrier): boolean {
  if (p.childOrigin === 'shared-copy') return false
  return isNpmUpdatable(inferVaultOrigin(p))
}
