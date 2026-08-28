import { join } from 'node:path'
import { readLogTail, spawnWebProfile, stopWeb, waitForPort, isPortListening, findPidByPort, findProcessName } from '@dsh-launcher/core'
import { createProfile, removeProfile, scanProfiles } from '@dsh-launcher/profile-manager'
import { pluginAction } from '@dsh-launcher/marketplace'
import type { ApiHandler, RouteContext, RuntimeProc } from './types.js'

/** /api/profiles* —— 环境列表 / 新建 / 删除 / 启停 / 日志 / 状态 / 插件（含批量安装）/ 端口占用 */
export const profilesHandler: ApiHandler = async (ctx, _req, res, method, seg, body, url) => {
  const { profilesDir, pidDir, logDir, running, config, sourcePolicy } = ctx

  // GET /api/ports —— 当前运行端口 + 占用进程（端口冲突诊断用）
  if (seg.length === 1 && seg[0] === 'ports' && method === 'GET') {
    const ports = await Promise.all(
      [...running.entries()].map(async ([profile, proc]) => {
        const alive = await isPortListening(proc.port)
        const pid = alive ? findPidByPort(proc.port) : null
        return {
          profile,
          port: proc.port,
          running: alive,
          status: proc.status,
          pid,
          processName: pid ? findProcessName(pid) : null,
          url: alive ? `http://127.0.0.1:${proc.port}` : null,
        }
      }),
    )
    ports.sort((a, b) => a.port - b.port)
    ctx.sendJson(res, 200, { ports })
    return true
  }

  // GET /api/profiles
  if (seg.length === 1 && seg[0] === 'profiles' && method === 'GET') {
    const profiles = await Promise.all(scanProfiles(profilesDir).map((p) => ctx.profileView(p.name)))
    ctx.sendJson(res, 200, { profiles })
    return true
  }

  // GET /api/profiles/status?names=a,b,c —— 合并轮询
  if (seg.length === 2 && seg[0] === 'profiles' && seg[1] === 'status' && method === 'GET') {
    const names = (url.searchParams.get('names') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.length === 0) {
      ctx.sendJson(res, 200, { statuses: {} })
      return true
    }
    const statuses: Record<string, unknown> = {}
    for (const n of names) {
      try {
        statuses[n] = await ctx.profileStatusView(decodeURIComponent(n))
      } catch {
        statuses[n] = { name: n, running: false, starting: false, port: null, pid: null }
      }
    }
    ctx.sendJson(res, 200, { statuses })
    return true
  }

  // POST /api/profiles  { name }
  if (seg.length === 1 && seg[0] === 'profiles' && method === 'POST') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      ctx.sendJson(res, 400, { error: '环境名只能含字母/数字/-/_（≤64）' })
      return true
    }
    try {
      const dir = createProfile(profilesDir, name)
      ctx.sendJson(res, 201, { profile: name, dir })
    } catch (err) {
      ctx.sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // DELETE /api/profiles/:name
  if (seg.length === 2 && seg[0] === 'profiles' && method === 'DELETE') {
    const name = decodeURIComponent(seg[1] ?? '')
    const proc = running.get(name)
    if (proc && proc.status !== 'error') {
      ctx.sendJson(res, 409, { error: `Profile "${name}" 正在运行，请先停止` })
      return true
    }
    if (proc) {
      running.delete(name)
      ctx.persistRuntime()
    }
    try {
      removeProfile(profilesDir, name)
      ctx.sendJson(res, 200, { ok: true })
    } catch (err) {
      ctx.sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /api/profiles/:name/start
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'start' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const existing = running.get(name)
    if (existing && existing.status !== 'error') {
      ctx.sendJson(res, 409, { error: `Profile "${name}" 已在运行` })
      return true
    }
    if (existing) running.delete(name)
    ctx.ensureUnifiedKernel(name)
    const basePort = Number(body.port) || config.webKernel.defaultPort || 3080
    const port = await ctx.findFreePort(basePort)
    const { child } = spawnWebProfile({
      profile: name,
      port,
      logDir,
      pidDir,
      dshBin: ctx.resolveDshBin(name),
    })
    const proc: RuntimeProc = { port, child, startedAt: Date.now(), status: 'starting' }
    running.set(name, proc)
    ctx.persistRuntime()
    child.on('close', () => {
      if (running.get(name) !== proc) return
      if (proc.status === 'starting') {
        proc.status = 'error'
        proc.error = '进程提前退出（未监听端口），请查看日志诊断'
      } else {
        running.delete(name)
      }
      ctx.persistRuntime()
    })
    void (async () => {
      const ready = await waitForPort(port, 60_000)
      if (running.get(name) === proc) {
        if (ready) proc.status = 'running'
        else {
          proc.status = 'error'
          proc.error = `启动超时：端口 ${port} 在 60 秒内未就绪，请查看日志诊断`
        }
      }
    })()
    ctx.sendJson(res, 202, { status: 'starting', profile: name, port, pid: child.pid ?? null })
    return true
  }

  // POST /api/profiles/:name/stop
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'stop' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const proc = running.get(name)
    if (!proc) {
      ctx.sendJson(res, 404, { error: `Profile "${name}" 未在运行` })
      return true
    }
    const r = await stopWeb(pidDir, proc.port)
    running.delete(name)
    ctx.persistRuntime()
    ctx.sendJson(res, 200, r)
    return true
  }

  // GET /api/profiles/:name/log
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'log' && method === 'GET') {
    const name = decodeURIComponent(seg[1] ?? '')
    const proc = running.get(name)
    const logFile = proc ? join(logDir, `dsh-${name}-${proc.port}.log`) : ''
    ctx.sendJson(res, 200, { profile: name, log: logFile ? readLogTail(logFile) : '' })
    return true
  }

  // GET /api/profiles/:name/status
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'status' && method === 'GET') {
    const name = decodeURIComponent(seg[1] ?? '')
    const proc = running.get(name)
    if (!proc) {
      ctx.sendJson(res, 200, { profile: name, running: false, starting: false, port: null, pid: null })
      return true
    }
    if (proc.child === null) {
      const runningState = await isPortListening(proc.port)
      ctx.sendJson(res, 200, {
        profile: name,
        running: runningState,
        starting: false,
        port: proc.port,
        pid: runningState ? findPidByPort(proc.port) : null,
      })
      return true
    }
    ctx.sendJson(res, 200, {
      profile: name,
      running: proc.status === 'running',
      starting: proc.status === 'starting',
      port: proc.port,
      pid: proc.child.pid ?? null,
      error: proc.status === 'error' ? (proc.error ?? '启动失败') : null,
    })
    return true
  }

  // GET /api/profiles/:name/plugins
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'plugins' && method === 'GET') {
    const name = decodeURIComponent(seg[1] ?? '')
    const p = scanProfiles(profilesDir).find((x) => x.name === name)
    const dependencies = p?.dependencies ?? {}
    const bundles = p?.bundles ?? []
    const installedNames = [...new Set([...Object.keys(dependencies), ...bundles])]
    ctx.sendJson(res, 200, { profile: name, dependencies, bundles, installedNames })
    return true
  }

  // POST /api/profiles/:name/plugins  { action, pkg }
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'plugins' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const action = body.action as string
    const pkg = body.pkg as string
    if (!['add', 'remove', 'update'].includes(action) || !pkg) {
      ctx.sendJson(res, 400, { error: 'body 需要 { action: add|remove|update, pkg }' })
      return true
    }
    const decision = sourcePolicy.check(pkg)
    if (!decision.allowed) {
      ctx.sendJson(res, 403, { error: decision.reason })
      return true
    }
    const r = await pluginAction(name, action as 'add' | 'remove' | 'update', pkg)
    ctx.sendJson(res, r.ok ? 200 : 400, { ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr })
    return true
  }

  // POST /api/profiles/:name/plugins/batch  { packages: string[] }
  if (seg.length === 4 && seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'batch' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const packages = body.packages as unknown
    if (!Array.isArray(packages) || packages.length === 0) {
      ctx.sendJson(res, 400, { error: 'body 需要 { packages: string[] }' })
      return true
    }
    const results: { pkg: string; ok: boolean; error?: string; stdout?: string }[] = []
    for (const pkg of packages) {
      const p = typeof pkg === 'string' ? pkg.trim() : ''
      if (!p) {
        results.push({ pkg: String(pkg), ok: false, error: '空包名' })
        continue
      }
      const decision = sourcePolicy.check(p)
      if (!decision.allowed) {
        results.push({ pkg: p, ok: false, error: decision.reason })
        continue
      }
      try {
        const r = await pluginAction(name, 'add', p)
        results.push(r.ok ? { pkg: p, ok: true } : { pkg: p, ok: false, error: r.stderr || '安装失败', stdout: r.stdout })
      } catch (err) {
        results.push({ pkg: p, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const okCount = results.filter((r) => r.ok).length
    ctx.sendJson(res, okCount === results.length ? 200 : 207, {
      profile: name,
      results,
      ok: okCount,
      failed: results.length - okCount,
    })
    return true
  }

  return false
}
