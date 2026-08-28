import { join } from 'node:path'
import { readLogTail } from '@godsh/core'
import { listTemplates } from '@godsh/kernel-manager'
import { scanProfiles } from '@godsh/profile-manager'
import type { ApiHandler } from './types.js'

/** /api/unified-kernel* —— 统一内核配置 / 应用 / 还原 */
export const unifiedKernelHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { unifiedKernel, profilesDir } = ctx

  // GET /api/unified-kernel
  if (seg.length === 1 && seg[0] === 'unified-kernel' && method === 'GET') {
    ctx.sendJson(res, 200, { unifiedKernel: unifiedKernel.read() })
    return true
  }

  // PUT /api/unified-kernel
  if (seg.length === 1 && seg[0] === 'unified-kernel' && method === 'PUT') {
    const cfg = unifiedKernel.read()
    const wasEnabled = cfg.enabled
    if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled
    if (Array.isArray(body.plugins)) {
      cfg.plugins = (body.plugins as unknown[])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .filter((p) => typeof p.id === 'string' && p.id !== '')
        .map((p) => ({
          id: p.id as string,
          name: typeof p.name === 'string' ? (p.name as string) : undefined,
          disabled: p.disabled === true,
        }))
    }
    const saved = unifiedKernel.save(cfg)
    // 开关变化时联动：启用 → 应用到全部 Profile；禁用 → 还原全部
    let applied: unknown[] = []
    const profiles = scanProfiles(profilesDir)
    if (saved.enabled && !wasEnabled) applied = unifiedKernel.applyToAll(profiles)
    if (!saved.enabled && wasEnabled) applied = unifiedKernel.revertFromAll(profiles)
    ctx.sendJson(res, 200, { unifiedKernel: saved, applied })
    return true
  }

  // POST /api/unified-kernel/apply | /revert
  if (seg.length === 2 && seg[0] === 'unified-kernel' && (seg[1] === 'apply' || seg[1] === 'revert') && method === 'POST') {
    const profiles = scanProfiles(profilesDir)
    const results = seg[1] === 'apply' ? unifiedKernel.applyToAll(profiles) : unifiedKernel.revertFromAll(profiles)
    const changed = results.filter((r) => r.added.length || r.error)
    ctx.sendJson(res, 200, { results, changed: changed.length })
    return true
  }

  // PUT /api/unified-kernel/profile/:name  { enabled: boolean | null } —— 单个环境注入覆盖
  if (seg.length === 3 && seg[0] === 'unified-kernel' && seg[1] === 'profile' && method === 'PUT') {
    const name = decodeURIComponent(seg[2] ?? '')
    const enabled = body.enabled === null || body.enabled === undefined ? null : body.enabled !== false
    const saved = unifiedKernel.setProfileOverride(name, enabled)
    // 覆盖变化即时生效：true → 应用到该环境；false/null → 还原该环境（若曾注入）
    const profiles = scanProfiles(profilesDir)
    const profile = profiles.find((p) => p.name === name)
    let applied: unknown[] = []
    if (profile) {
      if (enabled === true) applied = [unifiedKernel.applyToProfile(profile)]
      else applied = [unifiedKernel.revertProfile(profile)]
    }
    ctx.sendJson(res, 200, { unifiedKernel: saved, applied })
    return true
  }

  return false
}

/** /api/kernels* —— 内核模板与实例 CRUD / 启停 / 日志 */
export const kernelsHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { kernels, templatesDir, logDir } = ctx

  // GET /api/kernels
  if (seg.length === 1 && seg[0] === 'kernels' && method === 'GET') {
    ctx.sendJson(res, 200, { templates: listTemplates(templatesDir), instances: kernels.list() })
    return true
  }

  // POST /api/kernels
  if (seg.length === 1 && seg[0] === 'kernels' && method === 'POST') {
    const inst = kernels.create({
      templateId: body.templateId as string,
      profile: body.profile as string,
      port: typeof body.port === 'number' ? body.port : undefined,
      name: body.name as string,
    })
    ctx.sendJson(res, 201, { instance: inst })
    return true
  }

  // POST /api/kernels/:id/start | /stop
  if (seg.length === 3 && seg[0] === 'kernels' && (seg[2] === 'start' || seg[2] === 'stop') && method === 'POST') {
    const id = decodeURIComponent(seg[1] ?? '')
    if (seg[2] === 'start') {
      const target = kernels.get(id)
      if (target?.profile) ctx.ensureUnifiedKernel(target.profile)
      const inst = await kernels.start(id, ctx.resolveDshBin(target?.profile))
      ctx.sendJson(res, 200, { instance: inst })
      return true
    }
    const inst = await kernels.stop(id)
    ctx.sendJson(res, 200, { instance: inst })
    return true
  }

  // GET /api/kernels/:id/log
  if (seg.length === 3 && seg[0] === 'kernels' && seg[2] === 'log' && method === 'GET') {
    const id = decodeURIComponent(seg[1] ?? '')
    const inst = kernels.get(id)
    if (!inst) {
      ctx.sendJson(res, 404, { error: `内核实例不存在: ${id}` })
      return true
    }
    if (!inst.profile || !inst.port) {
      ctx.sendJson(res, 200, { instance: id, log: '' })
      return true
    }
    const logFile = join(logDir, `dsh-${inst.profile}-${inst.port}.log`)
    ctx.sendJson(res, 200, { instance: id, log: readLogTail(logFile) })
    return true
  }

  // DELETE /api/kernels/:id
  if (seg.length === 2 && seg[0] === 'kernels' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    kernels.remove(id)
    ctx.sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
