import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanProfiles } from '@godsh/profile-manager'
import type { SnapshotMeta } from './types.js'

/**
 * BackupManager：多版本环境快照与灾难恢复
 */
export class BackupManager {
  constructor(private profilesDir: string, private backupRootDir: string) {
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
  createSnapshot(profileName: string, tag?: string): SnapshotMeta {
    const profiles = scanProfiles(this.profilesDir)
    const profile = profiles.find((p) => p.name === profileName)
    if (!profile) {
      throw new Error(`环境不存在: ${profileName}`)
    }

    const patchPath = join(profile.dir, 'cordis.patch.yml')
    const patchContent = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''

    const snapshotId = `snap-${Date.now()}`
    const meta: SnapshotMeta = {
      id: snapshotId,
      profile: profileName,
      timestamp: Date.now(),
      tag,
      bundles: [...(profile.bundles ?? [])],
      dependencies: { ...(profile.dependencies ?? {}) },
      patchContent,
    }

    const savePath = join(this.getProfileBackupDir(profileName), `${snapshotId}.json`)
    writeFileSync(savePath, JSON.stringify(meta, null, 2), 'utf8')
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
   * 一键回滚到指定快照
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

    // 1. 还原 patch
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (meta.patchContent) {
      writeFileSync(patchPath, meta.patchContent, 'utf8')
    }

    // 2. 还原 package.json
    const pkgPath = join(profileDir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pj = JSON.parse(readFileSync(pkgPath, 'utf8'))
        pj.dependencies = meta.dependencies
        if (!pj.dsh) pj.dsh = {}
        if (!pj.dsh.profile) pj.dsh.profile = {}
        pj.dsh.profile.bundles = meta.bundles
        writeFileSync(pkgPath, JSON.stringify(pj, null, 2), 'utf8')
      } catch {
        /* 忽略 */
      }
    }
    return true
  }
}
