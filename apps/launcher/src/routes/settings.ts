import { DATA_DIR, KERNEL_TEMPLATES_DIR, LOGS_DIR, PLUGINS_DIR, findDshInstances, type LauncherConfig } from '@godsh/core'
import type { ApiHandler } from './types.js'

/** /api/settings*、/api/backup* —— 配置读写 / 数据导出导入 */
export const settingsHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { store } = ctx

  // GET /api/settings
  if (seg.length === 1 && seg[0] === 'settings' && method === 'GET') {
    const cfg = store.readConfig()
    const dshInstances = findDshInstances(cfg.dsh.dirs ?? [])
    ctx.sendJson(res, 200, {
      config: cfg,
      dshInstances,
      paths: { dataDir: DATA_DIR, logDir: LOGS_DIR, templatesDir: KERNEL_TEMPLATES_DIR, pluginsDir: PLUGINS_DIR },
    })
    return true
  }

  // PUT /api/settings
  if (seg.length === 1 && seg[0] === 'settings' && method === 'PUT') {
    const next = store.readConfig()
    const dsh = body.dsh as Record<string, unknown> | undefined
    if (dsh && typeof dsh === 'object') {
      if (typeof dsh.home === 'string') next.dsh.home = dsh.home
      if (typeof dsh.bin === 'string') next.dsh.bin = dsh.bin
      if (typeof dsh.activeVersion === 'string') next.dsh.activeVersion = dsh.activeVersion
      if (dsh.instances && typeof dsh.instances === 'object') {
        for (const [k, v] of Object.entries(dsh.instances)) {
          if (typeof v === 'string' && v) next.dsh.instances![k] = v
        }
      }
      if (dsh.byProfile && typeof dsh.byProfile === 'object') {
        for (const [k, v] of Object.entries(dsh.byProfile)) {
          if (typeof v === 'string') {
            if (v) next.dsh.byProfile![k] = v
            else delete next.dsh.byProfile![k]
          }
        }
      }
      if (Array.isArray(dsh.dirs)) next.dsh.dirs = dsh.dirs.filter((x): x is string => typeof x === 'string')
    }
    const pm = body.pluginMarket as Record<string, unknown> | undefined
    if (pm && typeof pm === 'object') {
      if (typeof pm.enabled === 'boolean') next.pluginMarket.enabled = pm.enabled
      if (typeof pm.indexUrl === 'string') next.pluginMarket.indexUrl = pm.indexUrl
    }
    if (Array.isArray(body.allowedOrigins)) {
      next.allowedOrigins = body.allowedOrigins.filter((x): x is string => typeof x === 'string')
    }
    store.writeConfig(next)
    ctx.allowedOrigins.value = next.allowedOrigins ?? []
    ctx.sendJson(res, 200, { config: next })
    return true
  }

  // GET /api/backup
  if (seg.length === 1 && seg[0] === 'backup' && method === 'GET') {
    const backup = {
      app: 'godsh',
      version: ctx.config.launcher.version,
      exportedAt: new Date().toISOString(),
      config: store.readConfig(),
      kernels: store.read('kernels.json', { kernels: [] }),
      allocations: store.read('allocations.json', { allocations: [] }),
      unifiedKernel: store.read('unified-kernel.json', { enabled: true, plugins: [], managed: {} }),
    }
    ctx.sendJson(res, 200, backup)
    return true
  }

  // POST /api/backup/restore
  if (seg.length === 2 && seg[0] === 'backup' && seg[1] === 'restore' && method === 'POST') {
    const b = body.backup as Record<string, unknown> | undefined
    if (!b || typeof b !== 'object') {
      ctx.sendJson(res, 400, { error: 'body 需要 { backup }' })
      return true
    }
    const restored: string[] = []
    if (b.config && typeof b.config === 'object') {
      store.writeConfig(b.config as LauncherConfig)
      restored.push('config.json')
    }
    if (b.kernels && typeof b.kernels === 'object') {
      store.write('kernels.json', b.kernels as { kernels: unknown[] })
      restored.push('kernels.json')
    }
    if (b.allocations && typeof b.allocations === 'object') {
      store.write('allocations.json', b.allocations as { allocations: unknown[] })
      restored.push('allocations.json')
    }
    if (b.unifiedKernel && typeof b.unifiedKernel === 'object') {
      store.write('unified-kernel.json', b.unifiedKernel as { enabled: boolean; plugins: unknown[]; managed: unknown })
      restored.push('unified-kernel.json')
    }
    ctx.sendJson(res, 200, { ok: true, restored })
    return true
  }

  return false
}
