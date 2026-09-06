import type { ApiHandler } from './types.js'

/**
 * /api/vault* —— 插件仓库沙箱管理（Plugin Vault Hub）
 * 涵盖：NTFS Junction 零拷贝挂载、伴随依赖自愈、多版本快照回滚、
 * 静态安全审计、环境反向收割、空间收益指标与垃圾回收。
 */
export const vaultHandler: ApiHandler = async (ctx, _req, res, method, seg, body, url) => {
  const { vault, profilesDir } = ctx

  // GET /api/vault —— 获取沙箱所有就绪态插件
  if (seg.length === 1 && seg[0] === 'vault' && method === 'GET') {
    const plugins = vault.list()
    ctx.sendJson(res, 200, { plugins, count: plugins.length })
    return true
  }

  // GET /api/vault/metrics —— 空间节省与沙箱性能指标
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'metrics' && method === 'GET') {
    const metrics = vault.calculateDiskSavings(profilesDir)
    ctx.sendJson(res, 200, metrics)
    return true
  }

  // GET /api/vault/history —— 获取部署快照与回滚历史
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'history' && method === 'GET') {
    const profile = url.searchParams.get('profile') || undefined
    const snapshots = vault.getHistory(profile)
    ctx.sendJson(res, 200, { snapshots })
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

  // POST /api/vault/deploy  { pluginId: string, targetProfile: string, version?: string } —— 零拷贝瞬时挂载
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'deploy' && method === 'POST') {
    const { pluginId, targetProfile, version } = body as { pluginId?: string; targetProfile?: string; version?: string }
    if (!pluginId || !targetProfile) {
      ctx.sendJson(res, 400, { error: '缺少 pluginId 或 targetProfile' })
      return true
    }
    try {
      const report = await vault.deployToProfile(pluginId, targetProfile, profilesDir, version)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/unmount  { pluginId: string, targetProfile: string } —— 热拔插安全卸载
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'unmount' && method === 'POST') {
    const { pluginId, targetProfile } = body as { pluginId?: string; targetProfile?: string }
    if (!pluginId || !targetProfile) {
      ctx.sendJson(res, 400, { error: '缺少 pluginId 或 targetProfile' })
      return true
    }
    try {
      const report = await vault.unmountFromProfile(pluginId, targetProfile, profilesDir)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/batch-deploy  { pluginIds: string[], targetProfiles: string[] } —— 广播式批量挂载
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'batch-deploy' && method === 'POST') {
    const { pluginIds, targetProfiles } = body as { pluginIds?: string[]; targetProfiles?: string[] }
    if (!Array.isArray(pluginIds) || !Array.isArray(targetProfiles) || pluginIds.length === 0 || targetProfiles.length === 0) {
      ctx.sendJson(res, 400, { error: '缺少 pluginIds 或 targetProfiles 数组' })
      return true
    }
    const results: Record<string, Record<string, { ok: boolean; error?: string }>> = {}
    for (const prof of targetProfiles) {
      results[prof] = {}
      for (const pid of pluginIds) {
        try {
          await vault.deployToProfile(pid, prof, profilesDir)
          results[prof][pid] = { ok: true }
        } catch (e) {
          results[prof][pid] = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
    }
    ctx.sendJson(res, 200, { ok: true, results })
    return true
  }

  // POST /api/vault/switch-version  { pluginId, targetProfile, targetVersion } —— 多版本原子切换
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'switch-version' && method === 'POST') {
    const { pluginId, targetProfile, targetVersion } = body as { pluginId?: string; targetProfile?: string; targetVersion?: string }
    if (!pluginId || !targetProfile || !targetVersion) {
      ctx.sendJson(res, 400, { error: '缺少 pluginId, targetProfile 或 targetVersion' })
      return true
    }
    try {
      const report = await vault.switchVersion(pluginId, targetProfile, targetVersion, profilesDir)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/rollback  { pluginId, targetProfile } —— 一键原子快照回滚
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'rollback' && method === 'POST') {
    const { pluginId, targetProfile } = body as { pluginId?: string; targetProfile?: string }
    if (!pluginId || !targetProfile) {
      ctx.sendJson(res, 400, { error: '缺少 pluginId 或 targetProfile' })
      return true
    }
    try {
      const report = await vault.rollback(targetProfile, pluginId, profilesDir)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/audit  { pluginId?: string } —— 静态安全审计 (AST/敏感探测)
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'audit' && method === 'POST') {
    const { pluginId } = body as { pluginId?: string }
    try {
      if (pluginId) {
        const report = await vault.auditPlugin(pluginId)
        ctx.sendJson(res, 200, { ok: true, report })
      } else {
        const allReports = await vault.auditAll()
        ctx.sendJson(res, 200, { ok: true, ...allReports })
      }
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/harvest —— 从各 Profile 反向收割（支持单插件或全量）
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'harvest' && method === 'POST') {
    const { profile, pluginName } = (body || {}) as { profile?: string; pluginName?: string }
    try {
      if (profile && pluginName) {
        const report = await vault.harvestSingle(profile, pluginName, profilesDir)
        ctx.sendJson(res, 200, report)
      } else {
        const report = await vault.harvestFromProfiles(profilesDir)
        ctx.sendJson(res, 200, { ok: true, ...report })
      }
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/update —— 单插件下载升级至目标版本（默认 latest）并同步已挂载 Profile
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'update' && method === 'POST') {
    const { id, version } = (body || {}) as { id?: string; version?: string }
    if (!id) {
      ctx.sendJson(res, 400, { error: '缺少插件 id' })
      return true
    }
    try {
      const report = await vault.updatePlugin(id, version, profilesDir)
      ctx.sendJson(res, 200, report)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/update-all —— 批量自动拉取升级所有有新版本的沙箱插件
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'update-all' && method === 'POST') {
    try {
      const report = await vault.updateAll(profilesDir)
      ctx.sendJson(res, 200, { ok: true, ...report })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/gc —— 沙箱垃圾大扫除
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'gc' && method === 'POST') {
    try {
      const report = await vault.garbageCollect(profilesDir)
      ctx.sendJson(res, 200, { ok: true, ...report })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/vault/check-updates —— 批量静默比对 npmmirror 版本
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'check-updates' && method === 'POST') {
    const updates = await vault.checkUpdates()
    ctx.sendJson(res, 200, { updates })
    return true
  }

  // POST /api/vault/clean-dangling —— 清理失效环境的悬空引用
  if (seg.length === 2 && seg[0] === 'vault' && seg[1] === 'clean-dangling' && method === 'POST') {
    const cleaned = vault.cleanDanglingProfiles(profilesDir)
    ctx.sendJson(res, 200, { ok: true, cleaned, message: `已清理 ${cleaned} 条失效环境的悬空索引` })
    return true
  }

  // DELETE /api/vault/:id —— 从沙箱移除
  if (seg.length === 2 && seg[0] === 'vault' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    const ok = await vault.remove(id)
    ctx.sendJson(res, 200, { ok })
    return true
  }

  return false
}

