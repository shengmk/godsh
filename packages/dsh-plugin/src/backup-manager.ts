import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfiles } from '@godsh/profile-manager'
import { defaultJournal } from '@godsh/core'
import type { SnapshotMeta } from './types.js'

export interface CreateSnapshotOptions {
  tag?: string
  trigger?: 'manual' | 'auto-pre-update' | 'auto-pre-install' | 'repair-workflow'
  description?: string
  isLocked?: boolean
}

/**
 * BackupManager：多版本环境快照时光机与灾难恢复
 */
export class BackupManager {
  constructor(private profilesDir: string, private backupRootDir: string = join(profilesDir, '..', 'backups')) {
    mkdirSync(this.backupRootDir, { recursive: true })
  }

  private getProfileBackupDir(profile: string): string {
    const dir = join(this.backupRootDir, profile)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 创建环境快照
   */
  createSnapshot(profileName: string, tagOrOptions?: string | CreateSnapshotOptions): SnapshotMeta {
    const profiles = scanProfiles(this.profilesDir)
    const profile = profiles.find((p) => p.name === profileName)
    if (!profile) {
      throw new Error(`环境不存在: ${profileName}`)
    }

    const opts: CreateSnapshotOptions =
      typeof tagOrOptions === 'string'
        ? { tag: tagOrOptions }
        : tagOrOptions ?? {}

    const patchPath = join(profile.dir, 'cordis.patch.yml')
    const patchContent = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''

    const workspacePath = join(profile.dir, 'pnpm-workspace.yaml')
    const workspaceContent = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : undefined

    const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const bundles = [...(profile.bundles ?? [])]
    const dependencies = { ...(profile.dependencies ?? {}) }

    const meta: SnapshotMeta = {
      id: snapshotId,
      profile: profileName,
      timestamp: Date.now(),
      tag: opts.tag,
      trigger: opts.trigger || 'manual',
      description: opts.description,
      godshVersion: '0.5.5',
      isLocked: Boolean(opts.isLocked),
      bundles,
      dependencies,
      patchContent,
      workspaceContent,
      metrics: {
        dependenciesCount: Object.keys(dependencies).length,
        bundlesCount: bundles.length,
        patchEntriesCount: patchContent ? patchContent.split(/\r?\n/).filter((l) => l.trim().startsWith('-')).length : 0,
      },
    }

    const savePath = join(this.getProfileBackupDir(profileName), `${snapshotId}.json`)
    writeFileSync(savePath, JSON.stringify(meta, null, 2), 'utf8')

    defaultJournal.log({
      level: 'info',
      category: 'snapshot',
      profile: profileName,
      action: `创建快照: ${snapshotId}`,
      status: 'success',
      details: opts.description || opts.tag || '手动快照',
    })

    return meta
  }

  /**
   * 列出环境全部历史快照
   */
  listSnapshots(profileName: string): SnapshotMeta[] {
    const dir = this.getProfileBackupDir(profileName)
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    const list: SnapshotMeta[] = []
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SnapshotMeta
        if (raw.id && raw.profile) list.push(raw)
      } catch {
        /* 忽略损坏文件 */
      }
    }
    return list.sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * 锁定或解锁快照（锁定后不被自动保留策略淘汰）
   */
  toggleLock(profileName: string, snapshotId: string, isLocked?: boolean): boolean {
    const snapPath = join(this.getProfileBackupDir(profileName), `${snapshotId}.json`)
    if (!existsSync(snapPath)) {
      throw new Error(`快照不存在: ${snapshotId}`)
    }
    const meta = JSON.parse(readFileSync(snapPath, 'utf8')) as SnapshotMeta
    meta.isLocked = typeof isLocked === 'boolean' ? isLocked : !meta.isLocked
    writeFileSync(snapPath, JSON.stringify(meta, null, 2), 'utf8')
    return meta.isLocked
  }

  /**
   * 删除指定快照
   */
  deleteSnapshot(profileName: string, snapshotId: string): boolean {
    const snapPath = join(this.getProfileBackupDir(profileName), `${snapshotId}.json`)
    if (!existsSync(snapPath)) return false
    try {
      unlinkSync(snapPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 执行保留策略清理超期快照
   * 默认每个环境保留最近 10 个快照，锁定快照永久保留
   */
  cleanExpiredSnapshots(profileName: string, maxKeepCount = 10, maxAgeDays = 14): { deleted: number; retained: number } {
    const snapshots = this.listSnapshots(profileName)
    const now = Date.now()
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
    let deleted = 0
    let retained = 0

    let unlockedCount = 0
    for (const snap of snapshots) {
      if (snap.isLocked) {
        retained++
        continue
      }
      unlockedCount++
      const isExpired = now - snap.timestamp > maxAgeMs
      const isOverQuota = unlockedCount > maxKeepCount
      if (isExpired || isOverQuota) {
        if (this.deleteSnapshot(profileName, snap.id)) {
          deleted++
        } else {
          retained++
        }
      } else {
        retained++
      }
    }

    return { deleted, retained }
  }

  /**
   * 获取快照存储统计
   */
  getStorageStats(profileName?: string): { totalSnapshots: number; totalBytes: number; profiles: Record<string, number>; profileBytes?: number } {
    if (!existsSync(this.backupRootDir)) {
      return { totalSnapshots: 0, totalBytes: 0, profiles: {}, profileBytes: 0 }
    }
    let totalSnapshots = 0
    let totalBytes = 0
    let profileBytes = 0
    const profileCounts: Record<string, number> = {}

    const entries = readdirSync(this.backupRootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const profDir = join(this.backupRootDir, entry.name)
        const files = readdirSync(profDir).filter((f) => f.endsWith('.json'))
        profileCounts[entry.name] = files.length
        totalSnapshots += files.length
        for (const file of files) {
          try {
            const sz = statSync(join(profDir, file)).size
            totalBytes += sz
            if (profileName && entry.name === profileName) {
              profileBytes += sz
            }
          } catch {}
        }
      }
    }

    return { totalSnapshots, totalBytes, profiles: profileCounts, profileBytes }
  }

  /**
   * 一键回滚到指定快照（原子安全回放，带有失败保底恢复）
   */
  restoreSnapshot(profileName: string, snapshotId: string): boolean {
    const snapPath = join(this.getProfileBackupDir(profileName), `${snapshotId}.json`)
    if (!existsSync(snapPath)) {
      throw new Error(`快照不存在: ${snapshotId}`)
    }
    const meta = JSON.parse(readFileSync(snapPath, 'utf8')) as SnapshotMeta
    const profileDir = join(this.profilesDir, profileName)
    if (!existsSync(profileDir)) {
      throw new Error(`目标环境目录不存在: ${profileName}`)
    }

    const patchPath = join(profileDir, 'cordis.patch.yml')
    const pkgPath = join(profileDir, 'package.json')
    const wsPath = join(profileDir, 'pnpm-workspace.yaml')

    // 暂存当前现场以支持写失败时原子自愈
    const backupOldPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null
    const backupOldPkg = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null

    try {
      // 1. 还原 patch
      if (meta.patchContent !== undefined) {
        writeFileSync(patchPath, meta.patchContent, 'utf8')
      }

      // 2. 还原 package.json
      if (existsSync(pkgPath)) {
        const pj = JSON.parse(readFileSync(pkgPath, 'utf8'))
        pj.dependencies = meta.dependencies || {}
        if (!pj.dsh) pj.dsh = {}
        if (!pj.dsh.profile) pj.dsh.profile = {}
        pj.dsh.profile.bundles = meta.bundles || []
        writeFileSync(pkgPath, JSON.stringify(pj, null, 2) + '\n', 'utf8')
      }

      // 3. 还原 workspace（若快照有保存）
      if (meta.workspaceContent !== undefined) {
        writeFileSync(wsPath, meta.workspaceContent, 'utf8')
      }

      defaultJournal.log({
        level: 'info',
        category: 'rollback',
        profile: profileName,
        action: `回滚到快照: ${snapshotId}`,
        status: 'success',
        details: meta.description || meta.tag || '',
      })

      return true
    } catch (err) {
      // 出现异常回放原先现场
      if (backupOldPatch !== null) writeFileSync(patchPath, backupOldPatch, 'utf8')
      if (backupOldPkg !== null) writeFileSync(pkgPath, backupOldPkg, 'utf8')
      defaultJournal.log({
        level: 'error',
        category: 'rollback',
        profile: profileName,
        action: `回滚快照失败: ${snapshotId}`,
        status: 'failed',
        details: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

export { BackupManager as DshBackupManager }
