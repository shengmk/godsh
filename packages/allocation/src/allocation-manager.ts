import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isOfficialPackage, type ConfigStore } from '@godsh/core'
import {
  readPatchChecked,
  serializePatchList,
  invalidateProfileCache,
  type PatchEntry,
} from '@godsh/profile-manager'
import type { Allocation } from './types.js'

interface AllocationsFile {
  allocations: Allocation[]
}

/**
 * 插件分配管理：把插件分配给 Profile，决定启用/禁用与顺序。
 * 分配关系持久化在 data/allocations.json，最终落地为 Profile 的 cordis.patch.yml。
 */
export class AllocationManager {
  private static FILE = 'allocations.json'

  constructor(private store: ConfigStore) {}

  list(): Allocation[] {
    return this.store.read<AllocationsFile>(AllocationManager.FILE, { allocations: [] }).allocations
  }

  listByProfile(profile: string): Allocation[] {
    return this.list()
      .filter((a) => a.profile === profile)
      .sort((a, b) => a.order - b.order)
  }

  private save(allocations: Allocation[]): void {
    this.store.write<AllocationsFile>(AllocationManager.FILE, { allocations })
  }

  allocate(profile: string, pluginId: string, pluginName: string): Allocation {
    const allocations = this.list()
    const existing = allocations.find((a) => a.profile === profile && a.pluginId === pluginId)
    if (existing) return existing

    const order = allocations.filter((a) => a.profile === profile).length
    const allocation: Allocation = {
      id: randomUUID(),
      profile,
      pluginId,
      pluginName,
      enabled: true,
      order,
    }
    allocations.push(allocation)
    this.save(allocations)
    return allocation
  }

  setEnabled(id: string, enabled: boolean): Allocation {
    const allocations = this.list()
    const a = allocations.find((x) => x.id === id)
    if (!a) throw new Error(`分配关系不存在: ${id}`)
    a.enabled = enabled
    this.save(allocations)
    return a
  }

  reorder(profile: string, orderedIds: string[]): void {
    const allocations = this.list()
    const byId = new Map(allocations.filter((a) => a.profile === profile).map((a) => [a.id, a]))
    orderedIds.forEach((id, index) => {
      const a = byId.get(id)
      if (a) a.order = index
    })
    this.save(allocations)
  }

  remove(id: string): void {
    this.save(this.list().filter((a) => a.id !== id))
  }

  /** 将某 Profile 的分配关系落为 cordis.patch.yml 条目。 */
  toPatchEntries(profile: string): PatchEntry[] {
    const entries: PatchEntry[] = []
    for (const a of this.listByProfile(profile)) {
      entries.push({
        op: 'insert',
        ids: [a.pluginId],
        disabledIds: a.enabled ? [] : [a.pluginId],
      })
    }
    return entries
  }

  serializeProfilePatch(profile: string): string {
    return serializePatchList(this.toPatchEntries(profile))
  }

  /**
   * 将某 Profile 的分配关系落地为真实的 cordis.patch.yml。
   * 只重写本管理器管理的插件条目，保留其它用户自定义条目。
   * @param removedIds 本次从分配关系中移除、需要一并从 patch 中清理的 pluginId（如删除分配后）
   * 返回写出的文件路径。
   *
   * 安全守护：
   * 1. 写回前先做「可解析性检查」——patch 含本工具无法理解的结构（嵌套配置 / !!js / $patch）时
   *    拒绝写回并抛错，避免破坏用户配置；
   * 2. 写回前将原 patch 备份到 data/patches-backup/<profile>-<时间戳>.yml，可随时恢复。
   */
  applyProfile(profilesDir: string, profile: string, removedIds: string[] = []): string {
    const dir = join(profilesDir, profile)
    if (!existsSync(dir)) throw new Error(`Profile 目录不存在: ${dir}`)
    const patchPath = join(dir, 'cordis.patch.yml')

    const managedIds = new Set([
      ...this.listByProfile(profile).map((a) => a.pluginId),
      ...removedIds,
    ])
    const existing = existsSync(patchPath) ? readPatchChecked(patchPath) : []

    // 移除本管理器管理的条目（含本次删除的）与官方 bundle，保留其它用户自定义条目。
    // 官方 bundle 判据统一取唯一事实源 @godsh/core 的 isOfficialPackage（官方作用域前缀 + 非空短名）：
    // 本模块不持有任何包名枚举，官方新增 / 改名 bundle 时这里无需改动。
    // 为什么必须剔除：官方 bundle 由 dsh 的 dsh.profile.bundles 机制加载，重复写进
    // cordis.patch.yml 会让 loader 报 "Cannot read properties of undefined (reading 'startsWith')" 而启动失败。
    const retained = existing
      .map((e) => {
        const ids = e.ids.filter((id) => !managedIds.has(id) && !isOfficialPackage(id))
        return ids.length ? { ...e, ids, disabledIds: e.disabledIds.filter((d) => !managedIds.has(d) && !isOfficialPackage(d)) } : null
      })
      .filter((e): e is PatchEntry => e !== null)

    const next = [...retained, ...this.toPatchEntries(profile).filter((e) => !e.ids.some(isOfficialPackage))]
    mkdirSync(dir, { recursive: true })
    // 没有条目且原本不存在 patch 文件时，不创建空文件（避免自动写回在无关 Profile 上制造垃圾文件）
    if (next.length === 0 && !existsSync(patchPath)) return patchPath
    // 备份原文件（若存在）
    if (existsSync(patchPath)) {
      try {
        const backupDir = join(this.store.dataDir, 'patches-backup')
        mkdirSync(backupDir, { recursive: true })
        const backupPath = join(backupDir, `${profile}-${Date.now()}.yml`)
        writeFileSync(backupPath, readFileSync(patchPath, 'utf8'), 'utf8')
      } catch {
        /* 备份失败不阻断写回（可解析性检查已是最强守护） */
      }
    }
    writeFileSync(patchPath, serializePatchList(next), 'utf8')
    // patch 已变更：失效该 Profile 的扫描缓存
    invalidateProfileCache(profilesDir)
    return patchPath
  }
}
