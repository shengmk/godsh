export interface ToolInfo {
  found: boolean
  path: string | null
  version: string | null
}

export interface Health {
  launcher: { name: string; version: string }
  dshHome: string
  profilesDir: string
  node: ToolInfo
  pnpm: ToolInfo
  dsh: ToolInfo
  errors: string[]
}

export interface ProfileView {
  name: string
  exists: boolean
  bundles: string[]
  dependencies: Record<string, string>
  patchEntries: number
  patchDisabled: string[]
  error: string | null
  /** 进程级启动失败诊断（如超时未就绪） */
  procError?: string | null
  running: boolean
  starting: boolean
  port: number | null
  pid: number | null
  url: string | null
}

/** 合并轮询用的轻量运行状态（/api/profiles/status?names=） */
export interface ProfileStatus {
  name: string
  running: boolean
  starting: boolean
  port: number | null
  pid: number | null
  procError?: string | null
  url: string | null
}

/** 端口占用条目（GET /api/ports） */
export interface PortInfo {
  profile: string
  port: number
  running: boolean
  status: string
  pid: number | null
  processName: string | null
  url: string | null
}

export type PluginKind = 'bundle' | 'client' | 'both' | 'unknown'

export type SecurityLevel = 'official' | 'safe' | 'warning' | 'danger'

export interface AuditFinding {
  ruleId: string
  severity: 'info' | 'warning' | 'danger'
  file: string
  line: number
  snippet: string
  message: string
}

export interface PluginAuditReport {
  pluginId: string
  pluginName: string
  version: string
  level: SecurityLevel
  score: number
  findings: AuditFinding[]
  scannedFiles: number
  auditedAt: number
}

export interface DeploymentSnapshot {
  id: string
  timestamp: number
  profile: string
  pluginId: string
  pluginName: string
  fromVersion?: string
  toVersion: string
  action: 'deploy' | 'switch' | 'rollback' | 'unmount' | 'remove'
}

export interface DiskSavingsReport {
  totalVaultBytes: number
  savedBytes: number
  totalJunctions: number
  pluginCount: number
}

export interface VaultPlugin {
  id: string
  name: string
  version: string
  kind: PluginKind
  source: 'market' | 'local'
  sourcePath?: string
  category?: string
  description?: string
  installedProfiles?: string[]
  hasUpdate?: boolean
  latestVersion?: string
  stagedAt: number
  versions?: string[]
  activeVersion?: string
  sizeBytes?: number
  securityLevel?: SecurityLevel
  securityScore?: number
  auditReport?: PluginAuditReport
  isJunctionLinked?: boolean
  /**
   * 子插件归属：存在即表示本条记录是某个父插件的附属子依赖，值为父插件的 id。
   *
   * 与 `kind` 是正交的两个维度（`kind` 说的是「这是什么插件」，`parentId` 说的是「这条记录归谁」），
   * 后端「依赖捆绑规则第三条」会为共同占有同一依赖的每个父各复制一份副本，因此**同名的子条目可能有多条**。
   */
  parentId?: string
  /** 子副本来源：standalone=池里那份唯一副本直接归到该父名下；shared-copy=为共同占有而按父复制的独立副本 */
  childOrigin?: 'standalone' | 'shared-copy'
  /** 仅根插件使用：本插件名下已捆绑的子依赖名 */
  bundledDeps?: string[]
}


export interface LocalPlugin {
  name: string
  dir: string
  version: string | null
  kind: PluginKind
  bundlePatch: string | null
  clientPlatform: string | null
  clientInject: string[]
  error?: string
}

export interface MarketPlugin {
  name: string
  version?: string
  description?: unknown
  homepage?: string
  repository?: string
  tags?: string[]
  /** 真实 npm 包名（name 是展示名，可能 ≠ npm；安装必须用 npm 字段） */
  npm?: string
  [key: string]: unknown
}

/** 市场分类概览（GET /api/market/categories） */
export interface MarketCategory {
  category: string
  count: number
  zh: string
}

export interface Allocation {
  id: string
  profile: string
  pluginId: string
  pluginName: string
  enabled: boolean
  order: number
  /**
   * 是否官方 DSH 资产。
   *
   * **由服务端判定并下发**（`@godsh/core` 的 `isOfficialPackage`，官方作用域前缀 + 非空短名），
   * 前端只消费该字段、不做任何包名字符串判定 —— 「官方」这一事实只有一处实现。
   * 官方资产的更新 / 卸载在前端据此拦截。
   */
  isOfficial: boolean
}

/**
 * 可分配的插件条目。
 *
 * **不含官方资产**：服务端已按同一条官方判据把它们从 `available` 里过滤掉
 * （官方资产退出「可分配」面，只在下方 {@link OfficialAssetView} 里只读展示）。
 * 因此这里没有 `isOfficial` 字段 —— 它恒为 false，留着只会是死字段。
 */
export interface AvailablePlugin {
  pluginId: string
  source: 'dependency' | 'bundle'
  allocated: boolean
  enabled: boolean
  /** 插件简介（市场索引 / 本地 package.json） */
  description?: string
  /** 插件版本 */
  version?: string
  /** 市场分类（dshmarket category；未归类为 undefined） */
  category?: string
}

/** 官方资产角色（与 @godsh/core 的 OfficialRole 同构；前端只用于选展示文案，不参与判定）。 */
export type OfficialRole = 'base' | 'web-app' | 'headless' | 'other'

/**
 * 官方资产的**只读视图**（GET /api/allocations/available 的 officialAssets）。
 *
 * - `version` 是服务端从该 Profile 的 `node_modules/<pkg>/package.json` 读到的**实装版本**；
 *   读不到为 `null`，界面显示「未知」（不会回退成市场最新版本号）。
 * - 该视图仅供展示：官方资产在界面上**没有任何操作入口**（不可更新 / 不可卸载 / 不可禁用）。
 */
export interface OfficialAssetView {
  name: string
  role: OfficialRole
  version: string | null
}

/** 批量安装的单个包结果（POST /profiles/:name/plugins/batch） */
export interface BatchInstallResult {
  pkg: string
  ok: boolean
  error?: string
  errorType?: string
  logFile?: string
  stdout?: string
}

/** 单插件安装/更新/卸载结果 */
export interface PluginActionResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  errorType?: string
  message?: string
  logFile?: string
}

export interface KernelTemplate {
  id: string
  type: string
  name: string
  defaultPort?: number
  resource?: { memoryMB?: number; cpu?: number }
}

export interface KernelInstance {
  id: string
  templateId: string
  name: string
  profile?: string
  port?: number
  status: string
  pid?: number | null
  createdAt: string
  error?: string
}

export interface UnifiedKernelPlugin {
  id: string
  name?: string
  disabled?: boolean
}

export interface UnifiedKernelConfig {
  enabled: boolean
  plugins: UnifiedKernelPlugin[]
  /** 按环境覆盖：profile 名 → false=跳过注入；true=强制注入 */
  byProfile?: Record<string, boolean>
}

export interface DshInstance {
  name: string
  path: string
  run: string
  version: string | null
}

export interface LauncherConfig {
  launcher: { name: string; version: string }
  dsh: {
    home: string
    bin: string
    profilesDir: string
    instances?: Record<string, string>
    activeVersion?: string
    byProfile?: Record<string, string>
    dirs?: string[]
  }
  runtime: { node: string; pnpm: string }
  webKernel: { defaultTemplateId: string; allowMultiPort?: boolean }
  pluginMarket: { enabled: boolean; indexUrl: string }
  /** 允许跨域访问 API 的来源（默认空 = 仅同源） */
  allowedOrigins?: string[]
  dataDir: string
}

export interface SettingsInfo {
  config: LauncherConfig
  dshInstances: DshInstance[]
  paths: {
    dataDir: string
    logDir: string
    templatesDir: string
    pluginsDir: string
  }
}

export type DshEnvKind = 'base' | 'managed' | 'external'

export interface DshEnv {
  id: string
  kind: DshEnvKind
  name: string
  dir: string
  run: string
  version: string | null
  requested?: string
  source?: string
}

export interface InstallTask {
  key: string
  status: 'running' | 'done' | 'error'
  message: string | null
  log: string
}

export interface DshStatus {
  found: boolean
  /** 当前实际使用版本（激活环境 → base → 首个检测） */
  currentVersion: string | null
  baseVersion: string | null
  activeVersion: string | null
  latestVersion: string | null
  activeVersionName: string
  detectedCount: number
  tasks: InstallTask[]
}

export interface DshEnvsInfo {
  envs: DshEnv[]
  activeVersionName: string
  byProfile: Record<string, string>
  tasks: InstallTask[]
}

export interface ProfilePackage {
  format: 'godsh-profile-package'
  version: string
  name: string
  exportedAt: number
  description?: string
  bundles: string[]
  dependencies: Record<string, string>
  patchYaml: string
  workspaceYaml?: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  desc: string
  recommendedProfile: string
}

export interface SnapshotItem {
  id: string
  profile: string
  timestamp: number
  tag?: string
  trigger?: 'manual' | 'auto-pre-update' | 'auto-pre-install' | 'repair-workflow'
  description?: string
  godshVersion?: string
  isLocked?: boolean
  bundles: string[]
  dependencies: Record<string, string>
  patchContent: string
}

export interface JournalEntryItem {
  timestamp: number
  isoTime: string
  level: 'info' | 'warn' | 'error'
  category: 'snapshot' | 'rollback' | 'vault' | 'repair' | 'desktop-launch' | 'system'
  profile?: string
  action: string
  status: 'success' | 'failed' | 'pending'
  details?: string
  operator?: 'user' | 'agent' | 'system'
}

export interface SystemTaskItem {
  key: string
  type: string
  status: 'running' | 'done' | 'error'
  message: string | null
  logFile?: string
  log?: string
}

export interface DshDesktopStatus {
  installed: boolean
  path: string | null
}


