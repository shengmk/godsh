import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import {
  diagnoseProfile,
  healProfile,
  safePurgeProfileJunctions,
  runPreflightCheck,
  type HealOptions,
} from '@godsh/core'
import type { ApiHandler } from './types.js'

/**
 * /api/doctor* —— Godsh 环境智能诊断与自愈路由
 * - POST /api/doctor/diagnose: 执行六层环境健康体检
 * - POST /api/doctor/preflight: 执行启动前快速门禁拦截检查
 * - POST /api/doctor/heal: 执行原子级安全自愈与 bundle 重建
 * - POST /api/doctor/safe-clean: 安全解除指定 profile 下的所有 Junction 屏障，杜绝穿透
 */
export const doctorHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { env, profilesDir } = ctx

  // POST /api/doctor/diagnose  { profile, port? }
  if (seg.length === 2 && seg[0] === 'doctor' && seg[1] === 'diagnose' && method === 'POST') {
    const profile = typeof body.profile === 'string' && body.profile ? body.profile.trim() : 'web'
    const port = typeof body.port === 'number' && body.port > 0 ? body.port : 3080
    try {
      const report = diagnoseProfile(env.dshHome, profile, port)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/doctor/preflight  { profile, port? }
  if (seg.length === 2 && seg[0] === 'doctor' && seg[1] === 'preflight' && method === 'POST') {
    const profile = typeof body.profile === 'string' && body.profile ? body.profile.trim() : 'web'
    const port = typeof body.port === 'number' && body.port > 0 ? body.port : 3080
    try {
      const preflight = runPreflightCheck(env.dshHome, profile, port)
      ctx.sendJson(res, 200, preflight)
    } catch (err) {
      ctx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/doctor/heal  { profile, options? }
  if (seg.length === 2 && seg[0] === 'doctor' && seg[1] === 'heal' && method === 'POST') {
    const profile = typeof body.profile === 'string' && body.profile ? body.profile.trim() : 'web'
    const options = (typeof body.options === 'object' && body.options ? body.options : {}) as HealOptions
    const dshBin = ctx.resolveDshBin(profile)
    try {
      const result = healProfile(env.dshHome, profile, options, dshBin)
      ctx.sendJson(res, 200, { ok: true, healed: result.healed, report: result.report })
    } catch (err) {
      ctx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/doctor/safe-clean  { profile }
  if (seg.length === 2 && seg[0] === 'doctor' && seg[1] === 'safe-clean' && method === 'POST') {
    const profile = typeof body.profile === 'string' && body.profile ? body.profile.trim() : ''
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    const profNm = join(profilesDir, profile, 'node_modules')
    if (!existsSync(profNm)) {
      ctx.sendJson(res, 200, { ok: true, unlinkedJunctions: 0, message: 'node_modules 不存在' })
      return true
    }

    try {
      // 第一阶段：构筑安全防穿透隔离屏障，先解除全部 Junction / Symlink
      const unlinked = safePurgeProfileJunctions(profNm)

      // 第二阶段：安全移除剩余普通物理文件与目录
      try {
        rmSync(profNm, { recursive: true, force: true })
      } catch {}

      ctx.sendJson(res, 200, {
        ok: true,
        unlinkedJunctions: unlinked,
        message: `已安全隔离解绑 ${unlinked} 个 Junction，并清空本地缓存`,
      })
    } catch (err) {
      ctx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  return false
}