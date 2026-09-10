export interface VaultCompanion {
  pkg: string
  version: string
  isBundle: boolean
}

export type CompatibilityShimType = 'settings-namespace' | 'llm-callid' | 'undici-handler' | 'model-selection'

export interface VaultContract {
  /** 必须伴随注入的配对插件 */
  companions?: VaultCompanion[]
  /** 该插件所需的兼容垫片类型 */
  requiredShims?: CompatibilityShimType[]
  /** 冲突互斥插件列表 */
  conflictsWith?: string[]
  /** DSH 内核要求 */
  dshEngineRange?: string
  /** 提示说明 */
  notes?: string
}

/** 社区核心插件伴随契约矩阵与互斥规则表 */
export const KNOWN_CONTRACTS: Record<string, VaultContract> = {
  'dsh-web-search-pro': {
    companions: [{ pkg: '@anweat/dsh-browser', version: '^0.1.10', isBundle: true }],
    requiredShims: ['settings-namespace', 'undici-handler'],
    notes: '依赖 @anweat/dsh-browser 浏览器插件与 undici 兼容垫片',
  },
  '@anweat/dsh-browser': {
    requiredShims: ['settings-namespace'],
    notes: '注入 DSH settingsNamespace 兼容导出',
  },
  'dsh-better-sidebar': {
    requiredShims: ['settings-namespace'],
    conflictsWith: ['dsh-pocket'],
    notes: '与部分极简侧边栏扩展可能存在样式重叠',
  },
  'dsh-agy-link': {
    requiredShims: ['llm-callid'],
    notes: '适配 DSH 0.1.2 ToolCallId -> CallId 别名',
  },
  'dsh-cost-meter': {
    requiredShims: ['settings-namespace'],
  },
  'dsh-dream-skin': {
    conflictsWith: ['@kubor/dsh-bloom-theme', '@nonamelego/dsh-catppuccin', 'dsh-theme-mineradio'],
    notes: '全量主题互斥检测',
  },
  '@kubor/dsh-bloom-theme': {
    conflictsWith: ['dsh-dream-skin', '@nonamelego/dsh-catppuccin', 'dsh-theme-mineradio'],
    notes: '全量主题互斥检测',
  },
  '@nonamelego/dsh-catppuccin': {
    conflictsWith: ['dsh-dream-skin', '@kubor/dsh-bloom-theme', 'dsh-theme-mineradio'],
    notes: '全量主题互斥检测',
  },
  'dsh-theme-mineradio': {
    conflictsWith: ['dsh-dream-skin', '@kubor/dsh-bloom-theme', '@nonamelego/dsh-catppuccin'],
    notes: '全量主题互斥检测',
  },
}

export function getVaultContract(pluginName: string): VaultContract | null {
  return KNOWN_CONTRACTS[pluginName] || null
}

export function detectPluginConflicts(pluginName: string, installedPlugins: string[]): string[] {
  const contract = getVaultContract(pluginName)
  if (!contract?.conflictsWith) return []
  return contract.conflictsWith.filter((p) => installedPlugins.includes(p))
}

/**
 * 反向依赖（契约表口径）：返回所有把 `targetName` 当作伴随插件（companion）的插件名。
 *
 * 动机（bug 3）：删除一个「被别人依赖的子插件」会让环境因缺依赖而打不开。
 * 删除前必须知道「谁依赖它」。实测运行态 82 个沙箱插件之间存在 39 条真实依赖边，
 * 而契约表只覆盖其中 1 条，因此本函数只是**一环**，完整判定见 `findDependentsOf`。
 */
export function findDependents(targetName: string): string[] {
  const out: string[] = []
  for (const [name, contract] of Object.entries(KNOWN_CONTRACTS)) {
    if (name === targetName) continue
    if (contract.companions?.some((c) => c.pkg === targetName)) out.push(name)
  }
  return out
}

/**
 * 反向依赖（契约表 + 实测 package.json 双口径）。
 *
 * @param targetName 待删除的插件名
 * @param installed  沙箱内全部插件与其 package.json 依赖集合（由调用方读取，本模块保持无 IO）
 */
export function findDependentsOf(
  targetName: string,
  installed: { name: string; dependencies: Record<string, string> }[],
): string[] {
  const out = new Set<string>(findDependents(targetName))
  for (const p of installed) {
    if (p.name === targetName) continue
    if (Object.hasOwn(p.dependencies, targetName)) out.add(p.name)
  }
  return [...out].sort()
}
