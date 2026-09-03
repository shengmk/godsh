import type { ApiHandler } from './types.js'

/**
 * /api/vault* —— 插件仓库沙箱管理（替代临时 pluginsbag profile）
 * 提供就绪态流转、本地插件导入、快速分发与静默版本比对。
 */
export const vaultHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { vault, profilesDir } = ctx

  // GET /api/vault —— 获取沙箱所有就绪态插件
  if (seg.length === 1 && seg[0] === 'vault' && method === 'GET') {
    const plugins = vault.list()
    ctx.sendJson(res, 200, { plugins, count: plugins.length })
    return true
  }

  // POST /api/vault/import-local  { targetPath: string, category?: string } —— 导入本地插件
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'import-local' && method === 'POST') {
    const { targetPath, category } = body as { targetPath?: string; category?: string }
    if (!targetPath) {
      ctx.sendJson(res, 400, { error: '缺少 targetPath 本地路径' })
      return true
    }
    try {
      const plugin = await vault.importLocal(targetPath, category)
      ctx.sendJson(res, 201, { ok: true, plugin })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/add-market  { name, version, description?, category? } —— 从市场暂存入沙箱
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'add-market' && method === 'POST') {
    const { name, version, description, category } = body as {
      name?: string
      version?: string
      description?: string
      category?: string
    }
    if (!name || !version) {
      ctx.sendJson(res, 400, { error: '缺少 name 或 version' })
      return true
    }
    const plugin = await vault.addFromMarket({ name, version, description, category })
    ctx.sendJson(res, 201, { ok: true, plugin })
    return true
  }

  // POST /api/vault/deploy  { pluginId: string, targetProfile: string } —— 瞬时分发注入 Profile
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'deploy' && method === 'POST') {
    const { pluginId, targetProfile } = body as { pluginId?: string; targetProfile?: string }
    if (!pluginId || !targetProfile) {
      ctx.sendJson(res, 400, { error: '缺少 pluginId 或 targetProfile' })
      return true
    }
    try {
      const report = await vault.deployToProfile(pluginId, targetProfile, profilesDir)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // DELETE /api/vault/:id —— 从沙箱移除
  if (seg.length === 2 && seg[0] === 'vault' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    const ok = await vault.remove(id)
    ctx.sendJson(res, 200, { ok })
    return true
  }

  // POST /api/vault/check-updates —— 批量静默比对 npmmirror 版本
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'check-updates' && method === 'POST') {
    const updates = await vault.checkUpdates()
    ctx.sendJson(res, 200, { updates })
    return true
  }

  return false
}
