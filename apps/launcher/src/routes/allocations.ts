import { scanProfiles } from '@dsh-launcher/profile-manager'
import type { ApiHandler } from './types.js'

/** /api/allocations* —— 分配 CRUD / 排序 / 移动 / 可分配清单（含 patch 写回守护与回滚） */
export const allocationsHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { profilesDir, allocations } = ctx

  // GET /api/allocations
  if (seg.length === 1 && seg[0] === 'allocations' && method === 'GET') {
    ctx.sendJson(res, 200, { allocations: allocations.list() })
    return true
  }

  // POST /api/allocations
  if (seg.length === 1 && seg[0] === 'allocations' && method === 'POST') {
    const profile = body.profile as string
    const pluginId = body.pluginId as string
    const pluginName = (body.pluginName as string) ?? pluginId
    if (!profile || !pluginId) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile, pluginId }' })
      return true
    }
    // 幂等：同一 Profile 已分配该插件时返回既有记录（created=false，不重复创建）
    const before = allocations.list().find((x) => x.profile === profile && x.pluginId === pluginId)
    const a = allocations.allocate(profile, pluginId, pluginName)
    if (body.enabled === false) allocations.setEnabled(a.id, false)
    // 自动写回 patch；写回失败（如 patch 含无法解析的结构）时回滚本次新建并报错，
    // 保证「分配记录」与「实际生效」一致；已存在的幂等分配不删除（那会误删用户原有条目）。
    const apply = ctx.tryApplyAllocation(profile)
    if (!apply.applied) {
      if (!before) allocations.remove(a.id)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败', allocation: before ? a : undefined })
      return true
    }
    ctx.sendJson(res, 201, { allocation: a, created: !before, ...apply })
    return true
  }

  // POST /api/allocations/apply  { profile }
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'apply' && method === 'POST') {
    const profile = body.profile as string
    if (!profile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile }' })
      return true
    }
    const path = allocations.applyProfile(profilesDir, profile)
    ctx.sendJson(res, 200, { ok: true, path })
    return true
  }

  // POST /api/allocations/reorder  { profile, orderedIds }
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'reorder' && method === 'POST') {
    const profile = body.profile as string
    const orderedIds = body.orderedIds as string[]
    if (!profile || !Array.isArray(orderedIds)) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile, orderedIds: string[] }' })
      return true
    }
    const before = allocations.listByProfile(profile).map((a) => a.id)
    allocations.reorder(profile, orderedIds)
    const apply = ctx.tryApplyAllocation(profile)
    if (!apply.applied) {
      allocations.reorder(profile, before)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { allocations: allocations.listByProfile(profile), ...apply })
    return true
  }

  // PATCH /api/allocations/:id  { enabled }
  if (seg.length === 2 && seg[0] === 'allocations' && method === 'PATCH') {
    const id = decodeURIComponent(seg[1] ?? '')
    const prevEnabled = allocations.list().find((x) => x.id === id)?.enabled
    const a = allocations.setEnabled(id, body.enabled !== false)
    const apply = ctx.tryApplyAllocation(a.profile)
    if (!apply.applied) {
      if (prevEnabled !== undefined) allocations.setEnabled(id, prevEnabled)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { allocation: a, ...apply })
    return true
  }

  // DELETE /api/allocations/:id
  if (seg.length === 2 && seg[0] === 'allocations' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    const target = allocations.list().find((x) => x.id === id)
    allocations.remove(id)
    const apply = target ? ctx.tryApplyAllocation(target.profile, [target.pluginId]) : { applied: false }
    if (target && !apply.applied) {
      const restored = allocations.allocate(target.profile, target.pluginId, target.pluginName)
      if (!target.enabled) allocations.setEnabled(restored.id, false)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { ok: true, ...apply })
    return true
  }

  // GET /api/allocations/available —— 每个 Profile 的「可分配插件」清单
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'available' && method === 'GET') {
    const all = allocations.list()
    const available: Record<string, { pluginId: string; source: 'dependency' | 'bundle'; allocated: boolean; enabled: boolean }[]> = {}
    for (const p of scanProfiles(profilesDir)) {
      const byId = new Map(all.filter((a) => a.profile === p.name).map((a) => [a.pluginId, a]))
      const seen = new Set<string>()
      const items: { pluginId: string; source: 'dependency' | 'bundle'; allocated: boolean; enabled: boolean }[] = []
      const add = (pluginId: string, source: 'dependency' | 'bundle') => {
        if (!pluginId || seen.has(pluginId)) return
        seen.add(pluginId)
        const a = byId.get(pluginId)
        items.push({ pluginId, source, allocated: Boolean(a), enabled: a ? a.enabled : false })
      }
      for (const dep of Object.keys(p.dependencies ?? {})) add(dep, 'dependency')
      for (const b of p.bundles ?? []) add(b, 'bundle')
      available[p.name] = items
    }
    ctx.sendJson(res, 200, { available })
    return true
  }

  // POST /api/allocations/:id/move  { profile }
  if (seg.length === 3 && seg[0] === 'allocations' && seg[2] === 'move' && method === 'POST') {
    const id = decodeURIComponent(seg[1] ?? '')
    const toProfile = body.profile as string
    if (!toProfile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile }' })
      return true
    }
    const target = allocations.list().find((x) => x.id === id)
    if (!target) {
      ctx.sendJson(res, 404, { error: `分配关系不存在: ${id}` })
      return true
    }
    if (target.profile === toProfile) {
      ctx.sendJson(res, 400, { error: '目标 Profile 与当前相同' })
      return true
    }
    const fromProfile = target.profile
    allocations.remove(id)
    const moved = allocations.allocate(toProfile, target.pluginId, target.pluginName)
    if (!target.enabled) allocations.setEnabled(moved.id, false)
    const oldApply = ctx.tryApplyAllocation(fromProfile, [target.pluginId])
    const newApply = ctx.tryApplyAllocation(toProfile)
    ctx.sendJson(res, 200, { allocation: moved, fromProfile, ...oldApply, newApply })
    return true
  }

  return false
}
