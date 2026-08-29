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
  MarketPlugin,
  PluginActionResult,
  PortInfo,
  ProfileStatus,
  ProfileView,
  SettingsInfo,
  UnifiedKernelConfig,
} from './types'

// 默认同源 /api（Web 模式）；Tauri 模式可设 VITE_API_BASE=http://127.0.0.1:4780/api
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `请求失败 (${res.status})`)
  return data
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
    req<{ status: string; port: number; pid: number | null }>(`/profiles/${encodeURIComponent(name)}/start`, {
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

  moveAllocation: (id: string, profile: string) =>
    req<{ allocation: Allocation }>(`/allocations/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }).then((r) => r.allocation),

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
}
