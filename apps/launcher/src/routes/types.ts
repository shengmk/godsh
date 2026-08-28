import http from 'node:http'
import type { ChildProcess } from 'node:child_process'
import type { ConfigStore, EnvInfo, LauncherConfig } from '@dsh-launcher/core'
import type { AllocationManager } from '@dsh-launcher/allocation'
import type { KernelManager, UnifiedKernelManager } from '@dsh-launcher/kernel-manager'
import type { DshEnvManager } from '@dsh-launcher/dsh-env'
import type { SourcePolicy } from '@dsh-launcher/security'

/** 会话内运行中的 dsh web 进程。 */
export interface RuntimeProc {
  port: number
  /** 会话内 spawn 的子进程；服务重启后从 runtime.json 恢复的进程为 null（按 pid 文件管理）。 */
  child: ChildProcess | null
  startedAt: number
  status: 'starting' | 'running' | 'error'
  /** 启动失败时的可读诊断信息（如超时未就绪） */
  error?: string
}

/** 后台安装任务记录。 */
export interface InstallTaskRecord {
  status: 'running' | 'done' | 'error'
  logFile: string
  message?: string
}

export interface ProfileStatusView {
  name: string
  running: boolean
  starting: boolean
  port: number | null
  pid: number | null
  procError: string | null
  url: string | null
}

export type ProfileViewResult = ProfileStatusView & {
  exists: boolean
  bundles: string[]
  dependencies: Record<string, string>
  patchEntries: number
  patchDisabled: string[]
  error: string | null
}

export interface ApplyResult {
  applied: boolean
  patchPath?: string
  applyError?: string
}

/**
 * 路由共享上下文：包含所有 manager、运行状态、目录与辅助函数。
 * 由 server.ts 装配后传入每个 route handler；handler 返回 true 表示已处理该请求。
 */
export interface RouteContext {
  store: ConfigStore
  env: EnvInfo
  profilesDir: string
  pidDir: string
  logDir: string
  pluginsDir: string
  templatesDir: string
  kernels: KernelManager
  allocations: AllocationManager
  unifiedKernel: UnifiedKernelManager
  dshEnvs: DshEnvManager
  sourcePolicy: SourcePolicy
  /** 启动时的配置快照（动态读取用 store.readConfig()） */
  config: LauncherConfig
  /** 会话内运行中的 dsh web 进程（profile → 进程） */
  running: Map<string, RuntimeProc>
  /** 后台安装任务（key → 状态 + 日志文件） */
  installTasks: Map<string, InstallTaskRecord>
  /** 市场索引缓存（5 分钟）；用可变引用以便跨路由共享 */
  marketCache: { at: number; plugins: unknown[] } | null
  /** 允许跨域来源（可变引用，PUT /api/settings 会更新） */
  allowedOrigins: { value: string[] }

  sendJson: (res: http.ServerResponse, status: number, data: unknown) => void
  /** 当前请求的 Origin（CORS 动态匹配用；同源请求为 null） */
  readonly reqOrigin: string | null
  persistRuntime: () => void
  ensureUnifiedKernel: (profile: string) => void
  resolveDshBin: (profile?: string) => string | undefined
  tryApplyAllocation: (profile: string, removedIds?: string[]) => ApplyResult
  getMarket: () => Promise<unknown[]>
  findFreePort: (base: number) => Promise<number>
  profileStatusView: (name: string) => Promise<ProfileStatusView>
  profileView: (name: string) => Promise<ProfileViewResult>
  startInstallTask: (
    key: string,
    logName: string,
    job: (log: (line: string) => void) => Promise<void>,
  ) => void
  installTaskView: (key: string) => { status: string; log: string; message?: string } | null
}

/** route handler：处理请求返回 true；未命中返回 false（由后续 handler / 404 兜底）。 */
export type ApiHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  seg: string[],
  body: Record<string, unknown>,
  url: URL,
) => Promise<boolean>
