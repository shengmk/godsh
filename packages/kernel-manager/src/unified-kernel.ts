import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigStore } from '@godsh/core'
import { invalidateProfileCache, type ProfileInfo } from '@godsh/profile-manager'

export interface UnifiedKernelPlugin {
  /** 插件 id（bundle 名，如 @deepseek-ai/dsh-web-app、dshmarket） */
  id: string
  /** 展示名（可选，缺省取 id） */
  name?: string
  disabled?: boolean
}

export interface UnifiedKernelConfig {
  /** 是否启用统一内核注入 */
  enabled: boolean
  /** 用户偏好的插件层（追加到每个 Profile 的 bundles） */
  plugins: UnifiedKernelPlugin[]
  /** 管理记录：profile → 由统一内核添加进 bundles 的 id（用于禁用时精确还原，不动用户原有条目） */
  managed: Record<string, string[]>
  /** 按环境覆盖：profile 名 → false 表示该环境跳过注入（true 表示强制注入，即使全局禁用） */
  byProfile?: Record<string, boolean>
}

export interface UnifiedApplyResult {
  profile: string
  added: string[]
  error?: string
}

/** 统一 Web 内核 bundle：加到 Profile 的 bundles 后，其 bundle patch 会加载完整的 Web 表面（host 服务 + client 插件）。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

const DEFAULT_UNIFIED_KERNEL: UnifiedKernelConfig = {
  enabled: true,
  plugins: [],
  managed: {},
}

/**
 * 统一内核：
 * 把「统一 Web 内核（@deepseek-ai/dsh-web-app）+ 用户偏好插件」作为 bundle 注入每个 Profile 的
 * `dsh.profile.bundles`（dsh 原生机制，与 `dsh plugin add` 维护的是同一列表）。
 *
 * 为什么不用 `dsh --patch` 注入？实测（dsh 0.1.1-rc.1）：--patch 只插入插件行本身，
 * 而 Web 表面由 dsh-web-app **bundle 自带的 cordis.patch.yml** 提供（几十个 host/client 行），
 * 单独注入 web-app 行会因缺少 webServer 服务而启动失败。只有把 bundle 加入 bundles 才会应用其 bundle patch。
 *
 * 安全：记录每个 Profile 由本管理器添加的 id；禁用/还原时只移除这些记录，不动用户原有条目，
 * 不改 cordis.patch.yml，不安装任何依赖（bundle 从 dsh 安装目录解析）。
 * 数据：data/unified-kernel.json
 */
export class UnifiedKernelManager {
  private static FILE = 'unified-kernel.json'

  constructor(private store: ConfigStore) {}

  read(): UnifiedKernelConfig {
    const cfg = this.store.read<UnifiedKernelConfig>(UnifiedKernelManager.FILE, DEFAULT_UNIFIED_KERNEL)
    return {
      enabled: cfg.enabled !== false,
      plugins: Array.isArray(cfg.plugins) ? cfg.plugins.filter((p) => p && typeof p.id === 'string') : [],
      managed: cfg.managed && typeof cfg.managed === 'object' ? cfg.managed : {},
      byProfile: cfg.byProfile && typeof cfg.byProfile === 'object' ? cfg.byProfile : {},
    }
  }

  save(cfg: UnifiedKernelConfig): UnifiedKernelConfig {
    const next: UnifiedKernelConfig = {
      enabled: cfg.enabled !== false,
      plugins: Array.isArray(cfg.plugins)
        ? cfg.plugins
            .filter((p) => p && typeof p.id === 'string')
            .map((p) => ({ id: p.id, name: p.name || p.id, disabled: p.disabled === true }))
        : [],
      managed: cfg.managed && typeof cfg.managed === 'object' ? cfg.managed : {},
      byProfile: cfg.byProfile && typeof cfg.byProfile === 'object' ? cfg.byProfile : {},
    }
    this.store.write(UnifiedKernelManager.FILE, next)
    return next
  }

  /** 设置单个环境的注入覆盖：true=强制注入；false=跳过；null/undefined=清除覆盖（跟随全局）。 */
  setProfileOverride(profile: string, enabled: boolean | null): UnifiedKernelConfig {
    const cfg = this.read()
    const by = { ...(cfg.byProfile ?? {}) }
    if (enabled === null || enabled === undefined) delete by[profile]
    else by[profile] = enabled
    cfg.byProfile = by
    return this.save(cfg)
  }

  addPlugin(id: string, name?: string): UnifiedKernelConfig {
    const cfg = this.read()
    if (!id || cfg.plugins.some((p) => p.id === id)) return cfg
    cfg.plugins.push({ id, name: name || id })
    return this.save(cfg)
  }

  removePlugin(id: string): UnifiedKernelConfig {
    const cfg = this.read()
    cfg.plugins = cfg.plugins.filter((p) => p.id !== id)
    return this.save(cfg)
  }

  setEnabled(id: string, enabled: boolean): UnifiedKernelConfig {
    const cfg = this.read()
    const p = cfg.plugins.find((x) => x.id === id)
    if (p) p.disabled = !enabled
    return this.save(cfg)
  }

  setGlobalEnabled(enabled: boolean): UnifiedKernelConfig {
    const cfg = this.read()
    cfg.enabled = enabled
    return this.save(cfg)
  }

  reorder(ids: string[]): UnifiedKernelConfig {
    const cfg = this.read()
    const byId = new Map(cfg.plugins.map((p) => [p.id, p]))
    cfg.plugins = ids
      .map((id) => byId.get(id))
      .filter((p): p is UnifiedKernelPlugin => p !== undefined)
    return this.save(cfg)
  }

  /** 期望注入某 Profile 的 bundle 列表（按环境覆盖 + 全局开关 + 禁用项）。 */
  private desiredBundles(cfg: UnifiedKernelConfig, profileName: string): string[] {
    const override = cfg.byProfile?.[profileName]
    const effectiveEnabled = override === undefined ? cfg.enabled : override
    const ids = effectiveEnabled ? [WEB_APP_BUNDLE] : []
    for (const p of cfg.plugins) if (!p.disabled && !ids.includes(p.id)) ids.push(p.id)
    return ids
  }

  private readProfileBundles(dir: string): { manifest: Record<string, unknown>; bundles: string[] } | null {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return null
    try {
      const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      const bundles = (
        (manifest.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined
      )?.bundles as string[] | undefined
      return { manifest, bundles: Array.isArray(bundles) ? bundles.filter((b): b is string => typeof b === 'string') : [] }
    } catch {
      return null
    }
  }

  /** 把一个 Profile 的 bundles 合并 desired（web-app 紧跟 dsh-base，用户插件追加尾部），无 BOM 写回 package.json。 */
  private writeProfileBundles(dir: string, manifest: Record<string, unknown>, bundles: string[]): void {
    const dsh = (manifest.dsh as Record<string, unknown> | undefined) ?? {}
    const profile = (dsh.profile as Record<string, unknown> | undefined) ?? {}
    profile.bundles = bundles
    dsh.profile = profile
    manifest.dsh = dsh
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    // bundles 已变更：失效该 Profile 的扫描缓存
    invalidateProfileCache(join(dir, '..', '..'))
  }

  /**
   * 为单个 Profile 应用统一内核（幂等）：把缺失的期望 bundle 追加到 bundles 并记录到 managed。
   * 返回本次新增的 id。
   */
  applyToProfile(profile: ProfileInfo): UnifiedApplyResult {
    try {
      const cfg = this.read()
      const result: UnifiedApplyResult = { profile: profile.name, added: [] }
      if (!profile.exists) return { ...result, error: 'Profile 目录缺失' }
      const data = this.readProfileBundles(profile.dir)
      if (!data) return { ...result, error: 'package.json 缺失或无法解析' }

      const desired = this.desiredBundles(cfg, profile.name)
      const recorded = cfg.managed[profile.name] ?? []
      const additions = desired.filter((id) => !data.bundles.includes(id) && !recorded.includes(id))
      if (!additions.length) return result

      const merged = [...data.bundles]
      for (const id of additions) {
        const idx = merged.indexOf('@deepseek-ai/dsh-base')
        if (idx >= 0) merged.splice(idx + 1, 0, id)
        else merged.push(id)
      }
      this.writeProfileBundles(profile.dir, data.manifest, merged)
      cfg.managed[profile.name] = [...recorded, ...additions]
      this.save(cfg)
      result.added = additions
      return result
    } catch (err) {
      return { profile: profile.name, added: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 还原单个 Profile：只移除本管理器记录过的 bundle 条目。返回移除的 id。 */
  revertProfile(profile: ProfileInfo): UnifiedApplyResult {
    try {
      const cfg = this.read()
      const result: UnifiedApplyResult = { profile: profile.name, added: [] }
      const recorded = cfg.managed[profile.name] ?? []
      if (!recorded.length) return result
      if (!profile.exists) return { ...result, error: 'Profile 目录缺失' }
      const data = this.readProfileBundles(profile.dir)
      if (!data) return { ...result, error: 'package.json 缺失或无法解析' }

      const next = data.bundles.filter((id) => !recorded.includes(id))
      if (next.length !== data.bundles.length) {
        this.writeProfileBundles(profile.dir, data.manifest, next)
        result.added = data.bundles.filter((id) => recorded.includes(id))
      }
      delete cfg.managed[profile.name]
      this.save(cfg)
      return result
    } catch (err) {
      return { profile: profile.name, added: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 应用到所有 Profile（每个按自身的 byProfile 覆盖判断）。 */
  applyToAll(profiles: ProfileInfo[]): UnifiedApplyResult[] {
    return profiles.map((p) => this.applyToProfile(p))
  }

  /** 还原所有 Profile（byProfile=true 强制注入的环境跳过还原，即使全局禁用也保留）。 */
  revertFromAll(profiles: ProfileInfo[]): UnifiedApplyResult[] {
    const cfg = this.read()
    return profiles.map((p) => {
      if (cfg.byProfile?.[p.name] === true) return { profile: p.name, added: [] }
      return this.revertProfile(p)
    })
  }
}
