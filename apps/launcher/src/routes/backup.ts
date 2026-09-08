import { DshBackupManager } from '@godsh/dsh-plugin'
import { defaultJournal } from '@godsh/core'
import type { ApiHandler } from './types.js'

/**
 * /api/backup* & /api/journal* —— 环境时间机器（时光机快照）与操作审计日记
 */
export const backupHandler: ApiHandler = async (ctx, _req, res, method, seg, body, url) => {
  const { profilesDir } = ctx
  const backupManager = new DshBackupManager(profilesDir)

  // ==================== 快照时光机路由 (/api/backup/*) ====================

  // GET /api/backup/snapshots?profile=<name> —— 查询环境快照列表与存储指标
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'snapshots' && method === 'GET') {
    const profile = url.searchParams.get('profile')
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    try {
      const snapshots = backupManager.listSnapshots(profile)
      const stats = backupManager.getStorageStats(profile)
      ctx.sendJson(res, 200, { snapshots, stats })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/backup/create { profile, description?, isLocked? } —— 手动创建快照
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'create' && method === 'POST') {
    const { profile, description, isLocked } = body as {
      profile?: string
      description?: string
      isLocked?: boolean
    }
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    try {
      const snapshot = backupManager.createSnapshot(profile, {
        description: description || '用户手动备份快照',
        trigger: 'manual',
        isLocked: Boolean(isLocked),
      })
      defaultJournal.log({
        level: 'info',
        category: 'snapshot',
        profile,
        action: '创建环境快照',
        status: 'success',
        details: `快照 ID: ${snapshot.id}`,
        operator: 'user',
      })
      ctx.sendJson(res, 201, { ok: true, snapshot })
    } catch (err) {
      defaultJournal.log({
        level: 'error',
        category: 'snapshot',
        profile,
        action: '创建环境快照失败',
        status: 'failed',
        details: err instanceof Error ? err.message : String(err),
        operator: 'user',
      })
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/backup/restore { profile, snapshotId } —— 一键原子回滚到指定快照
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'restore' && method === 'POST') {
    const { profile, snapshotId } = body as { profile?: string; snapshotId?: string }
    if (!profile || !snapshotId) {
      ctx.sendJson(res, 400, { error: '缺少 profile 或 snapshotId 参数' })
      return true
    }
    try {
      const success = backupManager.restoreSnapshot(profile, snapshotId)
      if (!success) {
        throw new Error(`回滚到快照 ${snapshotId} 失败`)
      }
      defaultJournal.log({
        level: 'warn',
        category: 'rollback',
        profile,
        action: '原子快照回滚',
        status: 'success',
        details: `已还原至快照: ${snapshotId}`,
        operator: 'user',
      })
      ctx.sendJson(res, 200, { ok: true, profile, snapshotId })
    } catch (err) {
      defaultJournal.log({
        level: 'error',
        category: 'rollback',
        profile,
        action: '原子快照回滚失败',
        status: 'failed',
        details: err instanceof Error ? err.message : String(err),
        operator: 'user',
      })
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/backup/toggle-lock { profile, snapshotId, isLocked? } —— 锁定/解锁快照
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'toggle-lock' && method === 'POST') {
    const { profile, snapshotId, isLocked } = body as {
      profile?: string
      snapshotId?: string
      isLocked?: boolean
    }
    if (!profile || !snapshotId) {
      ctx.sendJson(res, 400, { error: '缺少 profile 或 snapshotId 参数' })
      return true
    }
    try {
      const locked = backupManager.toggleLock(profile, snapshotId, isLocked)
      ctx.sendJson(res, 200, { ok: true, snapshotId, isLocked: locked })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // DELETE /api/backup/snapshot { profile, snapshotId } —— 删除快照
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'snapshot' && method === 'DELETE') {
    const profile = (body.profile as string) || url.searchParams.get('profile')
    const snapshotId = (body.snapshotId as string) || url.searchParams.get('snapshotId')
    if (!profile || !snapshotId) {
      ctx.sendJson(res, 400, { error: '缺少 profile 或 snapshotId' })
      return true
    }
    try {
      const ok = backupManager.deleteSnapshot(profile, snapshotId)
      ctx.sendJson(res, 200, { ok })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // GET /api/backup/stats?profile=<name> —— 查询存储空间统计
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'stats' && method === 'GET') {
    const profile = url.searchParams.get('profile')
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    const stats = backupManager.getStorageStats(profile)
    ctx.sendJson(res, 200, { stats })
    return true
  }

  // POST /api/backup/clean { profile, maxSnapshots?, retentionDays? } —— 清理过期快照
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'clean' && method === 'POST') {
    const { profile, maxSnapshots, retentionDays } = body as {
      profile?: string
      maxSnapshots?: number
      retentionDays?: number
    }
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    try {
      const resClean = backupManager.cleanExpiredSnapshots(profile, maxSnapshots, retentionDays)
      ctx.sendJson(res, 200, { ok: true, ...resClean })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // ==================== 审计日记路由 (/api/journal/*) ====================

  // GET /api/journal?profile=<name>&category=<cat>&limit=<limit> —— 检索审计日志
  if (seg.length === 1 && seg[0] === 'journal' && method === 'GET') {
    const profile = url.searchParams.get('profile') || undefined
    const category = url.searchParams.get('category') || undefined
    const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10)
    const entries = defaultJournal.getEntries(limit, profile, category)
    ctx.sendJson(res, 200, { entries })
    return true
  }

  // POST /api/journal/clear —— 清理审计日志
  if (seg.length === 2 && seg[0] === 'journal' && seg[1] === 'clear' && method === 'POST') {
    defaultJournal.clear()
    ctx.sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
