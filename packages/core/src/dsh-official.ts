/**
 * 官方 DSH 资产的**唯一事实源**。
 *
 * 为什么需要它
 * ------------
 * 官方 bundle（`@deepseek-ai/dsh-base` / `-web-app` / `-headless`）此前在本仓库里
 * 被**四处各自内联**成硬编码集合：
 *
 *   1. `apps/shell-web/src/pages/AllocationsPage.tsx` 的 `OFFICIAL_BUNDLES`
 *   2. `packages/allocation/src/allocation-manager.ts` 的 `OFFICIAL_BUNDLE_IDS`
 *   3. `packages/plugin-registry/src/vault.ts` 里 `deployToProfile` 内联的第三份
 *   4. 同文件三处 `if (OFFICIAL_BUNDLES.has(...)) continue` 的跳过分支
 *
 * 外加前端两条按包名分支的特殊文案（卸载保护与更新提示）。同一份事实散落四处，
 * 意味着官方新增或重命名一个 bundle 时要改四处，漏掉任何一处都会**静默失效**。
 *
 * 纪律（对应方案不变量 I2）
 * ------------------------
 * - godsh **不纳管、不实现、不复制、不写入**官方 DSH 资产。官方资产在本项目里
 *   只作为「只读事实」存在：用于环境启动、体检、以及界面上的只读展示。
 * - 判定一律走**作用域前缀**，而不是枚举包名 —— 官方新增 bundle 时这里无需改动，
 *   官方重命名（同作用域内）也无需改动。
 * - 本模块**不导出任何「禁止/允许」的业务分支**。调用方按需把
 *   {@link isOfficialPackage} 与自己领域的判据组合，而不是来这里找一个白名单。
 *
 * @module @godsh/core/dsh-official
 */

/** 官方 DSH 包所使用的 npm scope 前缀。 */
export const OFFICIAL_PACKAGE_SCOPE = '@deepseek-ai/'

/** 官方 DSH 资产的角色。`other` 表示「是官方包，但不是已知的三个内核 bundle」。 */
export type OfficialRole = 'base' | 'web-app' | 'headless' | 'other'

/** 已知官方内核 bundle 的短名 → 角色映射。 */
const KNOWN_ROLES: Readonly<Record<string, OfficialRole>> = {
  'dsh-base': 'base',
  'dsh-web-app': 'web-app',
  'dsh-headless': 'headless',
}

/**
 * 去掉官方作用域，返回短名；非官方包返回空串。
 *
 * 只做字符串切分，不做 npm 语义解析 —— 本项目的判据只需要「是不是同一作用域下的包」。
 *
 * @param name - 包名，如 `@deepseek-ai/dsh-base` 或 `dsh-skill-hub`。
 * @returns 官方包的短名，或空串。
 */
export function officialShortName(name: string): string {
  if (typeof name !== 'string') return ''
  if (!name.startsWith(OFFICIAL_PACKAGE_SCOPE)) return ''
  return name.slice(OFFICIAL_PACKAGE_SCOPE.length)
}

/**
 * 判断一个包是否为官方 DSH 包。
 *
 * 判据是**作用域前缀 + 非空短名**，因此 `@deepseek-ai/` 这种只有前缀的畸形输入返回
 * `false`，而官方将来新增的任何 `@deepseek-ai/*` 包自动落为 `true`（无需改这里）。
 *
 * @param name - 待判定的包名。
 * @returns 是官方包时为 `true`。
 */
export function isOfficialPackage(name: string): boolean {
  return officialShortName(name) !== ''
}

/**
 * 解析官方包的角色。
 *
 * @param name - 待判定的包名。
 * @returns 已知内核 bundle 返回其角色；其它官方包返回 `'other'`；非官方包返回 `null`。
 */
export function officialRole(name: string): OfficialRole | null {
  const short = officialShortName(name)
  if (short === '') return null
  return KNOWN_ROLES[short] ?? 'other'
}

/**
 * 官方资产的只读展示清单。
 *
 * **这不是白名单**：它不参与任何「能否操作」的判定，只用于界面把官方资产如实列出。
 * 操作面的判据一律是 {@link isOfficialPackage}。
 */
export interface OfficialAsset {
  /** 完整包名。 */
  name: string
  /** 该资产的角色。 */
  role: OfficialRole
}

/** 三个已知官方内核 bundle 的只读清单（展示用）。 */
export const KNOWN_OFFICIAL_BUNDLES: readonly OfficialAsset[] = [
  { name: `${OFFICIAL_PACKAGE_SCOPE}dsh-base`, role: 'base' },
  { name: `${OFFICIAL_PACKAGE_SCOPE}dsh-web-app`, role: 'web-app' },
  { name: `${OFFICIAL_PACKAGE_SCOPE}dsh-headless`, role: 'headless' },
] as const
