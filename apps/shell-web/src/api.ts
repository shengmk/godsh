import type {
  Allocation,
  AvailablePlugin,
  BatchInstallResult,
  DshEnv,
  DshEnvsInfo,
  DshInstance,
  DshStatus,
  Health,
  KernelInstance,
  KernelTemplate,
  LauncherConfig,
  LocalPlugin,
  MarketCategory,
  MarketPlugin,
  PluginActionResult,
  PortInfo,
  ProfileStatus,
  ProfileView,
  SettingsInfo,
  UnifiedKernelConfig,
  ProfilePackage,
  WorkflowTemplate,
  VaultPlugin,
  DiskSavingsReport,
  DeploymentSnapshot,
  PluginAuditReport,
  SnapshotItem,
  JournalEntryItem,
  SystemTaskItem,
  DshDesktopStatus,
} from './types'

import { isTauri, tauriInvoke } from './tauri'

// 非 Tauri（Web/浏览器）回退基址：默认同源 /api；也可由 VITE_API_BASE 覆盖。
const FALLBACK_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

// Tauri 桌面端：后端端口由 Rust 动态探测（4780 被占则顺延），
// 前端必须运行时查询实际端口，避免前后端端口错位导致「连接被拒绝」。
let basePromise: Promise<string> | null = null
function resolveBase(): Promise<string> {
  if (isTauri()) {
    basePromise ??= tauriInvoke('get_server_port')
      .then((port) => `http://127.0.0.1:${port as number}/api`)
      .catch(() => FALLBACK_BASE)
    return basePromise
  }
  return Promise.resolve(FALLBACK_BASE)
}

/** 端口自愈：当首选端口请求失败时，扫描 4780–4899 找真实后端（防 invoke 失效/端口顺延错位）。 */
let probedBase: string | null = null
async function probeBackend(): Promise<string | null> {
  if (probedBase) return probedBase
  const tries: number[] = []
  for (let port = 4780; port <= 4899; port++) tries.push(port)
  // 并发小批量探测，任一 /api/health 响应即视为命中
  const results = await Promise.allSettled(
    tries.map(async (port) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 700)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal })
        if (res.ok) return port
        throw new Error(String(res.status))
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled' && typeof r.value === 'number') {
      probedBase = `http://127.0.0.1:${r.value as number}/api`
      return probedBase
    }
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 带 HTTP 状态码的错误：让调用方能区分「确定性失败（4xx）」与「可重试失败（5xx/网络）」。 */
export class ApiError extends Error {
  readonly status: number
  /** 后端 409（被依赖阻断）响应体中的依赖方插件名列表，便于 UI 给出可操作提示。 */
  readonly dependents: string[]
  constructor(message: string, status: number, dependents: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.dependents = dependents
  }
}

/** 单次请求，不做任何重试。 */
async function requestOnce<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; dependents?: string[] }
  if (!res.ok) {
    const dependents = Array.isArray(data.dependents) ? data.dependents : []
    throw new ApiError(data.error ?? `请求失败 (${res.status})`, res.status, dependents)
  }
  return data
}

/**
 * 请求入口（修复 R1「点击无响应」根因）。
 *
 * 重试策略：
 * - 4xx 属**确定性失败**，立即抛出，绝不重试。早期实现无条件重试 8 次并退避到 3s，
 *   使一次「插件不存在 / 权限不足 / 冲突」这类必然失败的请求让用户白等约 13.7 秒，
 *   表现为「点了没反应」。
 * - 仅幂等方法（GET/HEAD）才重试，且只针对网络层失败与 5xx（后端冷启动竞态）。
 * - POST/PATCH/PUT/DELETE **不自动重发**（非幂等，重试可能产生重复副作用）；
 *   网络层失败时仍会做一次端口自愈探测，让**后续**请求打到正确端口。
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'HEAD'
  const maxAttempts = idempotent ? 5 : 1
  const primary = await resolveBase()
  let base = primary
  let lastErr: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await requestOnce<T>(base, path, init)
    } catch (err) {
      lastErr = err

      // 4xx：确定性失败，立即抛出（服务是通的，无需端口自愈也不必重试）
      if (err instanceof ApiError && err.status < 500) throw err

      // 网络层失败（TypeError：连接拒绝/中断）→ 尝试端口自愈换 base
      if (err instanceof TypeError && base === primary) {
        const found = await probeBackend()
        if (found) base = found
      }

      // 非幂等请求：只做端口自愈，绝不重发自身
      if (!idempotent) throw err

      // 已是最后一次：不再空等
      if (attempt === maxAttempts - 1) break

      // 冷启动竞态：后端起 server 需数秒，退避重试（上限收敛到 1.5s）
      await sleep(Math.min(300 * Math.pow(1.6, attempt), 1500))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('请求失败')
}

/** 沙箱移除模式：block 被依赖时拒绝（默认）；cascade 级联移除依赖方；force 强制仅摘除索引记录。 */
export type VaultRemoveMode = 'block' | 'cascade' | 'force'

/** 仓库沙箱：单插件移除响应（200 成功；404 未找到 / 409 被依赖阻断时由 ApiError 抛出）。 */
export interface VaultRemoveResult {
  ok: boolean
  name?: string
  unmountedFrom?: string[]
  dependents?: string[]
  purged?: boolean
}

/** 仓库沙箱：批量移除中单个插件的处理结果。 */
export interface VaultBatchRemoveItemResult {
  id: string
  name?: string
  status: 'removed' | 'blocked' | 'failed'
  reason?: string
  dependents?: string[]
}

/** 仓库沙箱：批量移除同步响应（逐项结果）。 */
export interface VaultBatchRemoveResult {
  ok: boolean
  results: VaultBatchRemoveItemResult[]
  removed: number
  blocked: number
  failed: number
}

/** 仓库沙箱：批量移除异步受理响应（202，需经 vaultTaskProgress 轮询）。 */
export interface VaultBatchRemoveAccepted {
  ok: true
  task: string
  message: string
}

export const api = {
  health: () => req<Health>('/health'),

  profiles: () => req<{ profiles: ProfileView[] }>('/profiles').then((r) => r.profiles),

  /** 合并轮询：一次请求返回多个 Profile 的轻量运行状态（3s 轮询用，替代逐环境请求） */
  profilesStatus: (names: string[]) =>
    req<{ statuses: Record<string, ProfileStatus> }>(
      `/profiles/status?names=${names.map((n) => encodeURIComponent(n)).join(',')}`,
    ).then((r) => r.statuses),

  startProfile: (name: string, port?: number) =>
    req<{ status: string; port: number; pid: number | null; url?: string }>(`/profiles/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      body: port ? JSON.stringify({ port }) : undefined,
    }),

  restartProfile: (name: string, port?: number) =>
    req<{ status: string; port: number; pid: number | null; url?: string }>(`/profiles/${encodeURIComponent(name)}/restart`, {
      method: 'POST',
      body: port ? JSON.stringify({ port }) : undefined,
    }),

  stopProfile: (name: string) =>
    req<{ ok: boolean; message: string }>(`/profiles/${encodeURIComponent(name)}/stop`, { method: 'POST' }),

  profileLog: (name: string) =>
    req<{ profile: string; log: string }>(`/profiles/${encodeURIComponent(name)}/log`),

  /** 端口占用视图：当前运行端口 + 占用进程（冲突诊断） */
  ports: () => req<{ ports: PortInfo[] }>('/ports').then((r) => r.ports),

  plugins: () => req<{ plugins: LocalPlugin[] }>('/plugins').then((r) => r.plugins),

  market: (q?: string) =>
    req<{ plugins: MarketPlugin[] }>(`/market${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.plugins),

  /** 市场分类概览（dshmarket 官方分类 → 插件数 + 中文名） */
  marketCategories: () =>
    req<{ categories: MarketCategory[] }>('/market/categories').then((r) => r.categories),

  /** 安装/更新插件。marketName 为市场展示名（可选）：后端据此解析真实安装参数（npm/github:/tgz）。 */
  installPlugin: (profile: string, action: 'add' | 'remove' | 'update', pkg: string, marketName?: string) =>
    req<PluginActionResult>(`/profiles/${encodeURIComponent(profile)}/plugins`, {
      method: 'POST',
      body: JSON.stringify({ action, pkg, ...(marketName ? { marketName } : {}) }),
    }),

  /** 智能卸载：dependencies 里的走 pnpm remove；纯 bundle 的从 bundles 移除（不再加载）。 */
  uninstallPlugin: (profile: string, pkg: string) =>
    req<{ ok: boolean; removed: string; method?: string; message?: string; errorType?: string }>(
      `/profiles/${encodeURIComponent(profile)}/plugins/uninstall`,
      {
        method: 'POST',
        body: JSON.stringify({ pkg }),
      },
    ),

  /** 批量安装：marketNames 与 packages 一一对应（可选，用于 github:/tgz 源解析）。 */
  installPluginsBatch: (profile: string, packages: string[], marketNames?: string[]) =>
    req<{ profile: string; results: BatchInstallResult[]; ok: number; failed: number }>(
      `/profiles/${encodeURIComponent(profile)}/plugins/batch`,
      {
        method: 'POST',
        body: JSON.stringify({ packages, ...(marketNames ? { marketNames } : {}) }),
      },
    ),

  /** 更新该环境全部已安装依赖（后台任务，返回 task key）。 */
  updateAllPlugins: (profile: string) =>
    req<{ profile: string; task: string | null; ok: number; failed: number; message?: string }>(
      `/profiles/${encodeURIComponent(profile)}/plugins/update-all`,
      { method: 'POST', body: '{}' },
    ),

  /** 轮询后台更新任务进度。 */
  updateAllProgress: (profile: string, task: string) =>
    req<{ status: string; log: string; message?: string }>(
      `/profiles/${encodeURIComponent(profile)}/plugins/update-all/progress?task=${encodeURIComponent(task)}`,
    ),

  allocations: () => req<{ allocations: Allocation[] }>('/allocations').then((r) => r.allocations),

  allocate: (profile: string, pluginId: string, pluginName: string, enabled: boolean) =>
    req<{ allocation: Allocation }>('/allocations', {
      method: 'POST',
      body: JSON.stringify({ profile, pluginId, pluginName, enabled }),
    }).then((r) => r.allocation),

  setEnabled: (id: string, enabled: boolean) =>
    req<{ allocation: Allocation }>(`/allocations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }).then((r) => r.allocation),

  removeAllocation: (id: string) => req<{ ok: boolean }>(`/allocations/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  applyAllocation: (profile: string) =>
    req<{ ok: boolean; path: string }>('/allocations/apply', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),

  reorderAllocations: (profile: string, orderedIds: string[]) =>
    req<{ allocations: Allocation[] }>('/allocations/reorder', {
      method: 'POST',
      body: JSON.stringify({ profile, orderedIds }),
    }).then((r) => r.allocations),

  allocationsAvailable: () =>
    req<{ available: Record<string, AvailablePlugin[]> }>('/allocations/available').then((r) => r.available),

  /** 按市场分类一键分配：把该环境已安装的该分类插件全部分配。 */
  assignCategory: (profile: string, category: string) =>
    req<{ assigned: number; skipped: number; matched: number; allocated: number }>(
      '/allocations/assign-category',
      {
        method: 'POST',
        body: JSON.stringify({ profile, category }),
      },
    ),

  moveAllocation: (id: string, profile: string) =>
    req<{ allocation: Allocation }>(`/allocations/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }).then((r) => r.allocation),

  /** 剪切并复制：跨环境转移插件，目标环境未安装时自动安装。 */
  moveWithInstall: (pluginId: string, toProfile: string, fromProfile?: string, marketName?: string) =>
    req<{ ok: boolean; allocation: Allocation; installed: boolean }>('/allocations/move-with-install', {
      method: 'POST',
      body: JSON.stringify({ pluginId, toProfile, ...(fromProfile ? { fromProfile } : {}), ...(marketName ? { marketName } : {}) }),
    }),

  kernels: () =>
    req<{ templates: KernelTemplate[]; instances: KernelInstance[] }>('/kernels'),

  createKernel: (body: { templateId: string; profile?: string; port?: number; name?: string }) =>
    req<{ instance: KernelInstance }>('/kernels', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.instance),

  kernelAction: (id: string, action: 'start' | 'stop') =>
    req<{ instance: KernelInstance }>(`/kernels/${encodeURIComponent(id)}/${action}`, { method: 'POST' }).then(
      (r) => r.instance,
    ),

  removeKernel: (id: string) => req<{ ok: boolean }>(`/kernels/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  unifiedKernel: () =>
    req<{ unifiedKernel: UnifiedKernelConfig }>('/unified-kernel').then((r) => r.unifiedKernel),

  updateUnifiedKernel: (cfg: UnifiedKernelConfig) =>
    req<{ unifiedKernel: UnifiedKernelConfig }>('/unified-kernel', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }).then((r) => r.unifiedKernel),

  unifiedKernelAction: (action: 'apply' | 'revert') =>
    req<{ results: { profile: string; added: string[]; error?: string }[]; changed: number }>(
      `/unified-kernel/${action}`,
      { method: 'POST' },
    ),

  /** 设置单个环境的统一内核注入覆盖（true=强制注入；false=跳过；null=跟随全局） */
  setUnifiedKernelProfile: (name: string, enabled: boolean | null) =>
    req<{ unifiedKernel: UnifiedKernelConfig }>(`/unified-kernel/profile/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }).then((r) => r.unifiedKernel),

  settings: () => req<SettingsInfo>('/settings'),

  updateSettings: (patch: Record<string, unknown>) =>
    req<{ config: LauncherConfig }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }).then((r) => r.config),

  kernelLog: (id: string) => req<{ instance: string; log: string }>(`/kernels/${encodeURIComponent(id)}/log`),

  backup: () => req<Record<string, unknown>>('/backup'),

  restoreBackup: (backup: Record<string, unknown>) =>
    req<{ ok: boolean; restored: string[] }>('/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ backup }),
    }),

  createProfile: (name: string) =>
    req<{ profile: string; dir: string }>('/profiles', { method: 'POST', body: JSON.stringify({ name }) }),

  deleteProfile: (name: string) =>
    req<{ ok: boolean }>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  profilePlugins: (name: string) =>
    req<{ profile: string; dependencies: Record<string, string>; bundles: string[]; installedNames: string[] }>(
      `/profiles/${encodeURIComponent(name)}/plugins`,
    ),

  dshStatus: () => req<DshStatus>('/dsh/status'),

  dshRefresh: () => req<{ ok: boolean; message?: string }>('/dsh/refresh', { method: 'POST' }),

  dshClearTasks: () => req<{ ok: boolean }>('/dsh/tasks/clear', { method: 'POST' }),

  dshVersions: () => req<{ published: string[]; local: DshInstance[] }>('/dsh/versions'),

  dshInstall: (version?: string) =>
    req<{ status: string; task: string }>('/dsh/install', {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  dshUpdate: () => req<{ status: string; task: string }>('/dsh/update', { method: 'POST' }),

  dshInitHome: (dshHome?: string) =>
    req<{ home: string; profilesDir: string; created: string[] }>('/dsh/init-home', {
      method: 'POST',
      body: JSON.stringify({ dshHome }),
    }),

  dshEnvs: () => req<DshEnvsInfo>('/dsh-envs'),

  dshEnvAdd: (name: string, version?: string) =>
    req<{ status: string; task: string }>('/dsh-envs', {
      method: 'POST',
      body: JSON.stringify({ name, version }),
    }),

  dshEnvRemove: (id: string) =>
    req<{ ok: boolean }>(`/dsh-envs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  dshEnvActivate: (id: string) =>
    req<{ env: DshEnv }>(`/dsh-envs/${encodeURIComponent(id)}/activate`, { method: 'POST' }).then((r) => r.env),

  resetAll: (scope: 'data' | 'all' | 'dsh-all') =>
    req<{ ok: boolean; scope: string }>('/reset', { method: 'POST', body: JSON.stringify({ scope }) }),

  appUninstall: () => req<{ ok: boolean; path: string }>('/app/uninstall', { method: 'POST' }),

  /** 导出环境完整配置包（Profile Package） */
  exportProfile: (name: string) =>
    req<{ package: ProfilePackage }>(`/profiles/${encodeURIComponent(name)}/export`).then((r) => r.package),

  /** 导入环境完整配置包 */
  importProfile: (body: { targetName?: string; package: ProfilePackage; override?: boolean; installDeps?: boolean }) =>
    req<{ ok: boolean; profile: string; dependenciesCount: number }>('/profiles/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 获取可用工作流模板列表 */
  workflows: () => req<{ workflows: WorkflowTemplate[] }>('/workflows').then((r) => r.workflows),

  /** 执行工作流（启动后台任务） */
  runWorkflow: (body: { workflowId?: string; profile?: string; steps?: unknown[] }) =>
    req<{ ok: boolean; task: string; title: string }>('/workflows/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 查询工作流任务执行进度与实时日志 */
  getWorkflowProgress: (taskKey: string) =>
    req<{ status: string; log: string; message?: string }>(`/workflows/progress?task=${encodeURIComponent(taskKey)}`),

  /** 批量规则：环境间一键克隆同步（复制 bundles 与插件分配） */
  syncProfileAllocations: (fromProfile: string, toProfile: string) =>
    req<{ ok: boolean; fromProfile: string; toProfile: string; copiedAllocations: number; bundles: number }>(
      '/allocations/batch-sync',
      {
        method: 'POST',
        body: JSON.stringify({ fromProfile, toProfile }),
      },
    ),

  /** 仓库沙箱：获取就绪态插件列表 */
  vault: () => req<{ plugins: VaultPlugin[] }>('/vault').then((r) => r.plugins),

  /** 仓库沙箱：空间节省与性能指标 */
  vaultMetrics: () => req<DiskSavingsReport>('/vault/metrics'),

  /** 仓库沙箱：获取部署与回滚历史快照 */
  vaultHistory: (profile?: string) =>
    req<{ snapshots: DeploymentSnapshot[] }>(`/vault/history${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`).then(
      (r) => r.snapshots,
    ),

  /** 仓库沙箱：导入本地插件 */
  vaultImportLocal: (targetPath: string, category?: string) =>
    req<{ ok: boolean; plugin: VaultPlugin }>('/vault/import-local', {
      method: 'POST',
      body: JSON.stringify({ targetPath, category }),
    }),

  /** 仓库沙箱：从市场暂存插件入库 */
  vaultAddMarket: (body: { name: string; version: string; description?: string; category?: string }) =>
    req<{ ok: boolean; plugin: VaultPlugin }>('/vault/add-market', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 仓库沙箱：NTFS Junction 零拷贝瞬时挂载 + 伴随自愈 */
  vaultDeploy: (pluginId: string, targetProfile: string, version?: string) =>
    req<{
      ok: boolean
      deployed: string[]
      companionAdded?: string[]
      isJunction?: boolean
      shimsApplied?: number
      conflicts?: string[]
    }>('/vault/deploy', {
      method: 'POST',
      body: JSON.stringify({ pluginId, targetProfile, version }),
    }),

  /** 仓库沙箱：热拔插安全卸载 */
  vaultUnmount: (pluginId: string, targetProfile: string) =>
    req<{ ok: boolean; unmounted: string }>('/vault/unmount', {
      method: 'POST',
      body: JSON.stringify({ pluginId, targetProfile }),
    }),

  /** 仓库沙箱：广播式批量挂载 */
  vaultBatchDeploy: (pluginIds: string[], targetProfiles: string[]) =>
    req<{ ok: boolean; results: Record<string, Record<string, { ok: boolean; error?: string }>> }>('/vault/batch-deploy', {
      method: 'POST',
      body: JSON.stringify({ pluginIds, targetProfiles }),
    }),

  /** 仓库沙箱：多版本原子切换 */
  vaultSwitchVersion: (pluginId: string, targetProfile: string, targetVersion: string) =>
    req<{ ok: boolean; fromVersion: string; toVersion: string }>('/vault/switch-version', {
      method: 'POST',
      body: JSON.stringify({ pluginId, targetProfile, targetVersion }),
    }),

  /** 仓库沙箱：一键原子快照回滚 */
  vaultRollback: (pluginId: string, targetProfile: string) =>
    req<{ ok: boolean; rolledBackTo: string; previousVersion: string }>('/vault/rollback', {
      method: 'POST',
      body: JSON.stringify({ pluginId, targetProfile }),
    }),

  /** 仓库沙箱：静态安全审计 (AST/敏感探测) */
  vaultAudit: (pluginId?: string) =>
    req<{ ok: boolean; report?: PluginAuditReport; reports?: Record<string, PluginAuditReport> }>('/vault/audit', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    }),

  /** 仓库沙箱：从环境反向收割纳管（单插件或全量） */
  vaultHarvest: (profile?: string, pluginName?: string) =>
    req<{ ok: boolean; plugin?: VaultPlugin; harvested?: VaultPlugin[]; totalProfilesScanned?: number; message?: string }>('/vault/harvest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pluginName }),
    }),

  /** 仓库沙箱：垃圾大扫除 */
  vaultGC: () =>
    req<{ ok: boolean; freedBytes: number; removedDirs: string[] }>('/vault/gc', {
      method: 'POST',
    }),

  /**
   * 仓库沙箱：移除插件。
   * mode 默认 block（被其他插件依赖时返回 409 并拒绝）；cascade 级联移除依赖方；force 强制移除。
   * purge=1 时同时清理磁盘上的实体包。
   */
  vaultRemove: (
    id: string,
    opts?: { mode?: VaultRemoveMode; purge?: boolean },
  ) => {
    const params = new URLSearchParams()
    if (opts?.mode) params.set('mode', opts.mode)
    if (opts?.purge) params.set('purge', '1')
    const qs = params.toString()
    return req<VaultRemoveResult>(`/vault/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, { method: 'DELETE' })
  },

  /**
   * 仓库沙箱：批量移除插件。
   * 未指定 async（或 false）时同步返回逐项结果（removed / blocked / failed）；
   * async 为 true 时后端 202 受理，返回 task，可经 vaultTaskProgress 轮询进度。
   */
  vaultBatchRemove: (
    ids: string[],
    opts?: { mode?: VaultRemoveMode; purge?: boolean; async?: boolean },
  ) =>
    req<VaultBatchRemoveResult | VaultBatchRemoveAccepted>('/vault/batch-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids,
        ...(opts?.mode ? { mode: opts.mode } : {}),
        ...(opts?.purge ? { purge: true } : {}),
        ...(opts?.async ? { async: true } : {}),
      }),
    }),

  /** 仓库沙箱：批量静默比对更新 */
  vaultCheckUpdates: () =>
    req<{ updates: { id: string; hasUpdate: boolean; latestVersion?: string }[] }>('/vault/check-updates', {
      method: 'POST',
    }),

  /** 仓库沙箱：单插件下载升级至目标版本并同步挂载环境 */
  vaultUpdatePlugin: (id: string, version?: string) =>
    req<{ ok: boolean; plugin?: VaultPlugin; fromVersion?: string; toVersion?: string; message?: string }>('/vault/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, version }),
    }),

  /** 仓库沙箱：一键自动更新全部有新版本的沙箱插件（同步） */
  vaultUpdateAll: () =>
    req<{
      ok: boolean
      total: number
      updated: number
      failed: number
      results: { id: string; name: string; ok: boolean; fromVersion?: string; toVersion?: string; error?: string }[]
    }>('/vault/update-all', {
      method: 'POST',
    }),

  /** 仓库沙箱：异步单插件下载升级（移交全局任务中心） */
  vaultUpdatePluginAsync: (id: string, version?: string) =>
    req<{ ok: boolean; task?: string; message?: string }>('/vault/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, version, async: true }),
    }),

  /** 仓库沙箱：异步一键自动更新全部有新版本的插件（移交全局任务中心） */
  vaultUpdateAllAsync: () =>
    req<{ ok: boolean; task?: string; message?: string }>('/vault/update-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ async: true }),
    }),

  /** 仓库沙箱：轮询沙箱后台更新任务进度与流式日志 */
  vaultTaskProgress: (task: string) =>
    req<{ status: 'running' | 'done' | 'error'; log: string; message?: string }>(
      `/vault/task-progress?task=${encodeURIComponent(task)}`
    ),

  /** 环境快照时光机：查询环境快照与统计 */
  backupSnapshots: (profile: string) =>
    req<{ snapshots: SnapshotItem[]; stats: any }>(`/backup/snapshots?profile=${encodeURIComponent(profile)}`),

  /** 环境快照时光机：创建快照 */
  backupCreate: (profile: string, description?: string, isLocked?: boolean) =>
    req<{ ok: boolean; snapshot: SnapshotItem }>('/backup/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, description, isLocked }),
    }),

  /** 环境快照时光机：回滚快照 */
  backupRestore: (profile: string, snapshotId: string) =>
    req<{ ok: boolean; profile: string; snapshotId: string }>('/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, snapshotId }),
    }),

  /** 环境快照时光机：锁定/解锁快照 */
  backupToggleLock: (profile: string, snapshotId: string, isLocked?: boolean) =>
    req<{ ok: boolean; snapshotId: string; isLocked: boolean }>('/backup/toggle-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, snapshotId, isLocked }),
    }),

  /** 环境快照时光机：删除快照 */
  backupDelete: (profile: string, snapshotId: string) =>
    req<{ ok: boolean }>('/backup/snapshot', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, snapshotId }),
    }),

  /** 环境快照时光机：按策略清理过期快照 */
  backupClean: (profile: string, maxSnapshots?: number, retentionDays?: number) =>
    req<{ ok: boolean; deleted: number; retained: number }>('/backup/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, maxSnapshots, retentionDays }),
    }),

  /** 操作审计日记：查询历史 */
  journalEntries: (profile?: string, category?: string, limit = 100) => {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    if (category) params.set('category', category)
    params.set('limit', String(limit))
    return req<{ entries: JournalEntryItem[] }>(`/journal?${params.toString()}`)
  },

  /** 操作审计日记：清理 */
  journalClear: () =>
    req<{ ok: boolean }>('/journal/clear', {
      method: 'POST',
    }),

  /** 7 阶段自愈工作流：启动 */
  repairWorkflow: (profile: string, targetSnapshotId?: string) =>
    req<{ ok: boolean; task: string; profile: string; message: string }>('/repair/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, targetSnapshotId }),
    }),

  /** 7 阶段自愈工作流：轮询任务进度 */
  repairTaskProgress: (task: string) =>
    req<{ status: 'running' | 'done' | 'error'; log: string; message?: string }>(
      `/repair/task-progress?task=${encodeURIComponent(task)}`
    ),

  /** 全局系统任务中心：获取全部任务 */
  systemTasks: () => req<{ tasks: SystemTaskItem[]; count: number }>('/tasks'),

  /** 全局系统任务中心：获取单个任务详情与实时日志 */
  systemTaskDetail: (key: string) =>
    req<{ key: string; status: 'running' | 'done' | 'error'; log: string; message?: string }>(
      `/tasks/${encodeURIComponent(key)}`
    ),

  /** 全局系统任务中心：清空已结束的历史任务 */
  systemTasksClear: () =>
    req<{ ok: boolean; cleared: number }>('/tasks/clear', {
      method: 'POST',
    }),

  /** DSH Desktop 状态检测 */
  dshDesktopStatus: () => req<DshDesktopStatus>('/dsh/desktop-status'),

  /** DSH Desktop 启动环境 */
  openDshDesktop: (profile: string) =>
    req<{ ok: boolean; profile: string; exe: string }>('/dsh/open-desktop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    }),
}


