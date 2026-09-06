import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '@godsh/core'
import { readPatchChecked, serializePatchList } from '@godsh/profile-manager'

/**
 * PatchManager：操作 cordis.patch.yml 实现零重启 HMR 热插拔与规则治理
 */
export class PatchManager {
  constructor(private profilesDir: string) {}

  private getPatchPath(profile: string): string {
    return join(this.profilesDir, profile, 'cordis.patch.yml')
  }

  private backupPatch(profile: string, patchPath: string): void {
    if (!existsSync(patchPath)) return
    try {
      const backupDir = join(DATA_DIR, 'patches-backup')
      mkdirSync(backupDir, { recursive: true })
      const backupPath = join(backupDir, `${profile}-${Date.now()}.yml`)
      writeFileSync(backupPath, readFileSync(patchPath, 'utf8'), 'utf8')
    } catch {
      // 备份失败不阻断流程
    }
  }

  /**
   * 读取环境 patch 列表
   */
  readPatch(profile: string): string[] {
    const p = this.getPatchPath(profile)
    if (!existsSync(p)) return []
    try {
      const parsed = readPatchChecked(p)
      const ids: string[] = []
      for (const e of parsed) {
        ids.push(...e.ids)
      }
      return ids
    } catch {
      return []
    }
  }

  /**
   * 热启用/热挂载插件到 patch
   */
  enablePlugin(profile: string, pluginId: string): boolean {
    const p = this.getPatchPath(profile)
    const list = existsSync(p) ? readPatchChecked(p) : []
    let insertEntry = list.find((e) => e.op === 'insert')
    if (!insertEntry) {
      insertEntry = { op: 'insert', ids: [], disabledIds: [] }
      list.push(insertEntry)
    }
    if (!insertEntry.ids.includes(pluginId)) {
      insertEntry.ids.push(pluginId)
    }
    insertEntry.disabledIds = insertEntry.disabledIds.filter((id) => id !== pluginId)

    this.backupPatch(profile, p)
    writeFileSync(p, serializePatchList(list), 'utf8')
    return true
  }

  /**
   * 热禁用插件（写入 disabled: true，Cordis File Watcher 捕获后瞬间卸载）
   */
  disablePlugin(profile: string, pluginId: string): boolean {
    const p = this.getPatchPath(profile)
    const list = existsSync(p) ? readPatchChecked(p) : []
    let insertEntry = list.find((e) => e.op === 'insert')
    if (!insertEntry) {
      insertEntry = { op: 'insert', ids: [], disabledIds: [] }
      list.push(insertEntry)
    }
    if (!insertEntry.ids.includes(pluginId)) {
      insertEntry.ids.push(pluginId)
    }
    if (!insertEntry.disabledIds.includes(pluginId)) {
      insertEntry.disabledIds.push(pluginId)
    }

    this.backupPatch(profile, p)
    writeFileSync(p, serializePatchList(list), 'utf8')
    return true
  }
}
