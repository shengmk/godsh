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
