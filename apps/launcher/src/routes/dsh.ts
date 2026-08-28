import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DATA_DIR, readLogTail, stopWeb } from '@dsh-launcher/core'
import { removeProfile, scanProfiles } from '@dsh-launcher/profile-manager'
import type { ApiHandler } from './types.js'

/** /api/dsh*、/api/dsh-envs* —— DSH 本体状态 / 安装 / 并列环境 */
export const dshHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { store, dshEnvs, pidDir, running, installTasks } = ctx

  // GET /api/dsh/status
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'status' && method === 'GET') {
    const st = dshEnvs.status()
    const tasks = [...installTasks.entries()].map(([key, rec]) => ({
      key,
      status: rec.status,
      message: rec.message ?? null,
      log: readLogTail(rec.logFile, 100),
    }))
    ctx.sendJson(res, 200, { ...st, tasks, activeVersionName: store.readConfig().dsh.activeVersion ?? '' })
    return true
  }

  // GET /api/dsh/versions
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'versions' && method === 'GET') {
    ctx.sendJson(res, 200, { published: dshEnvs.publishedVersions(), local: dshEnvs.detectedInstances() })
    return true
  }

  // POST /api/dsh/install  { version? }
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'install' && method === 'POST') {
    if (installTasks.has('base-install')) {
      ctx.sendJson(res, 409, { error: '安装正在进行中' })
      return true
    }
    const runningCount = [...running.values()].filter((p) => p.status === 'running').length
    if (runningCount > 0) {
      ctx.sendJson(res, 409, {
        error: `有 ${runningCount} 个环境正在运行。Windows 上运行中的 dsh 会占用依赖文件，请先停止全部环境再安装/更新 dsh。`,
      })
      return true
    }
    const version = typeof body.version === 'string' && body.version ? (body.version as string) : undefined
    ctx.startInstallTask('base-install', 'dsh-install.log', async (log) => {
      await dshEnvs.installBase(version, log)
    })
    ctx.sendJson(res, 202, { status: 'starting', task: 'base-install' })
    return true
  }

  // POST /api/dsh/update
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'update' && method === 'POST') {
    if (installTasks.has('base-update')) {
      ctx.sendJson(res, 409, { error: '更新正在进行中' })
      return true
    }
    const runningCount = [...running.values()].filter((p) => p.status === 'running').length
    if (runningCount > 0) {
      ctx.sendJson(res, 409, {
        error: `有 ${runningCount} 个环境正在运行。请先停止全部环境再安装/更新 dsh。`,
      })
      return true
    }
    ctx.startInstallTask('base-update', 'dsh-update.log', async (log) => {
      await dshEnvs.installBase(undefined, log)
    })
    ctx.sendJson(res, 202, { status: 'starting', task: 'base-update' })
    return true
  }

  // POST /api/dsh/init-home  { dshHome? }
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'init-home' && method === 'POST') {
    const dshHome = typeof body.dshHome === 'string' && body.dshHome ? (body.dshHome as string) : undefined
    try {
      const r = dshEnvs.initHome(dshHome)
      ctx.sendJson(res, 200, r)
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // GET /api/dsh-envs
  if (seg.length === 1 && seg[0] === 'dsh-envs' && method === 'GET') {
    const cfg = store.readConfig()
    ctx.sendJson(res, 200, {
      envs: dshEnvs.list(),
      activeVersionName: cfg.dsh.activeVersion ?? '',
      byProfile: cfg.dsh.byProfile ?? {},
      tasks: [...installTasks.entries()].map(([key, rec]) => ({
        key,
        status: rec.status,
        message: rec.message ?? null,
        log: readLogTail(rec.logFile, 100),
      })),
    })
    return true
  }

  // POST /api/dsh-envs  { name, version? }
  if (seg.length === 1 && seg[0] === 'dsh-envs' && method === 'POST') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      ctx.sendJson(res, 400, { error: '环境名只能含字母/数字/-/_（≤32）' })
      return true
    }
    if ([...installTasks.keys()].some((k) => k.startsWith('add:'))) {
      ctx.sendJson(res, 409, { error: '已有环境正在安装' })
      return true
    }
    const version = typeof body.version === 'string' && body.version ? (body.version as string) : undefined
    ctx.startInstallTask(`add:${name}`, `dsh-env-${name}.log`, async (log) => {
      await dshEnvs.addManaged(name, version, log)
    })
    ctx.sendJson(res, 202, { status: 'starting', task: `add:${name}` })
    return true
  }

  // DELETE /api/dsh-envs/:id
  if (seg.length === 2 && seg[0] === 'dsh-envs' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    try {
      dshEnvs.removeManaged(id)
      ctx.sendJson(res, 200, { ok: true })
    } catch (err) {
      ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/dsh-envs/:id/activate
  if (seg.length === 3 && seg[0] === 'dsh-envs' && seg[2] === 'activate' && method === 'POST') {
    const id = decodeURIComponent(seg[1] ?? '')
    try {
      const env = dshEnvs.activate(id)
      ctx.sendJson(res, 200, { env })
    } catch (err) {
      ctx.sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/reset  { scope: 'data' | 'all' | 'dsh-all' }
  if (seg.length === 1 && seg[0] === 'reset' && method === 'POST') {
    const scope = body.scope === 'all' ? 'all' : body.scope === 'dsh-all' ? 'dsh-all' : 'data'
    // 停止所有运行中的 Profile
    for (const [name, proc] of [...running.entries()]) {
      if (proc.status === 'running' || proc.status === 'starting') {
        try {
          await stopWeb(pidDir, proc.port)
        } catch {
          /* 忽略停止失败 */
        }
        running.delete(name)
      }
    }
    ctx.persistRuntime()
    if (scope === 'all' || scope === 'dsh-all') {
      for (const p of scanProfiles(ctx.profilesDir)) {
        try {
          removeProfile(ctx.profilesDir, p.name)
        } catch {
          /* 忽略单个失败 */
        }
      }
    }
    if (scope === 'dsh-all') {
      if (process.env.DSH_LAUNCHER_SKIP_NPM_UNINSTALL === '1') {
        dshEnvs.dropBaseRecord()
      } else {
        await dshEnvs.uninstallBase().catch(() => ({ ok: false, message: '' }))
      }
      dshEnvs.removeManagedRoot()
      const cfgBefore = store.readConfig()
      const home = cfgBefore.dsh.home || process.env.DSH_HOME || join(homedir(), '.dsh')
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
    const resetFiles = ['config.json', 'kernels.json', 'allocations.json', 'unified-kernel.json', 'dsh-envs.json']
    for (const f of resetFiles) {
      try {
        rmSync(join(DATA_DIR, f), { force: true })
      } catch {
        /* 忽略 */
      }
    }
    ctx.sendJson(res, 200, { ok: true, scope })
    return true
  }

  // POST /api/app/uninstall
  if (seg.length === 2 && seg[0] === 'app' && seg[1] === 'uninstall' && method === 'POST') {
    const exeDir = process.execPath ? dirname(process.execPath) : ''
    const uninstallExe = join(exeDir, 'uninstall.exe')
    if (!existsSync(uninstallExe)) {
      ctx.sendJson(res, 404, { error: '未找到 uninstall.exe（便携版不支持界面卸载）' })
      return true
    }
    spawn(uninstallExe, [], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => process.exit(0), 1500)
    ctx.sendJson(res, 200, { ok: true, path: uninstallExe })
    return true
  }

  return false
}
