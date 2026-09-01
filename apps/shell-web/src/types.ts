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
}

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
  webKernel: { defaultTemplateId: string; defaultPort: number; allowMultiPort?: boolean }
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

