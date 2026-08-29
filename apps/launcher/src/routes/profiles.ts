import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readLogTail, spawnWebProfile, stopWeb, waitForPort, isPortListening, findPidByPort, findProcessName, invalidatePortProbe } from '@godsh/core'
import { createProfile, removeProfile, scanProfiles } from '@godsh/profile-manager'
import { pluginAction, PLUGIN_ACTION_TIMEOUT_MS } from '@godsh/marketplace'
import type { ApiHandler, RouteContext, RuntimeProc } from './types.js'

/**
 * 启动失败诊断：读 dsh 日志，识别常见失败模式，给出可操作提示。
 * 返回给前端展示的 error 文案。
 */
function diagnoseStartFailure(logFile: string, port: number): string {
  try {
    const log = readLogTail(logFile, 200)
    const all = log || ''
    if (/YAMLException|bad indentation|cannot resolve profile bundle|failed to parse overlay/i.test(all)) {
      return '环境配置（cordis.patch.yml）损坏或 bundle 缺失，请到「插件分配」检查或重新安装插件'
    }
    if (/Cannot find package|ERR_MODULE_NOT_FOUND|failed to import loader entry/i.test(all)) {
      return '环境缺少依赖包，请到「DSH 环境」检查 dsh 安装完整性'
    }
    if (/ModuleNotFoundError|No module named|lingshu|aeis/i.test(all)) {
      return 'DSH 内置组件需要 Python 模块（灵枢/aeis），当前 Python 环境缺失，请联系 DSH 或安装对应模块'
    }
    if (/EADDRINUSE|port.*in use|already in use/i.test(all)) {
      return `端口 ${port} 被占用，请先停止占用该端口的进程`
    }
    const errLine = all
      .split(/\r?\n/)
      .find((l) => /Error|failed|error/i.test(l) && !/at .*\(/.test(l))
    if (errLine) return `启动失败：${errLine.trim().slice(0, 120)}`
    return '进程提前退出（未监听端口），请查看日志诊断'
  } catch {
    return '进程提前退出（未监听端口），请查看日志诊断'
  }
}

/** 安装/更新/卸载日志落盘：data/logs/plugin-<profile>-<pkg>-<ts>.log */
function logPluginAction(logDir: string, profile: string, action: string, pkg: string, r: { ok: boolean; code: number | null; stdout: string; stderr: string }): string {
  const name = pkg.replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 60)
  const file = join(logDir, `plugin-${profile}-${name}-${Date.now()}.log`)
  try {
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      file,
      `# dsh plugin --profile ${profile} ${action} ${pkg}\n# ok=${r.ok} code=${r.code}\n\n--- stdout ---\n${r.stdout}\n\n--- stderr ---\n${r.stderr}\n`,
      'utf8',
    )
  } catch {
    /* 日志写失败不阻断 */
  }
  return file
}

/** 从 dsh/pnpm 输出归类错误类型。 */
function classifyPluginError(r: { ok: boolean; code: number | null; stdout: string; stderr: string }): { errorType: string; message: string } {
  if (r.ok) return { errorType: 'ok', message: '' }
  const all = `${r.stdout}\n${r.stderr}`
  if (/timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|ECONNREFUSED/i.test(all)) return { errorType: 'network', message: '网络错误或连接超时，请检查网络后重试' }
  if (/not\s+found|No\s+match|E404|does\s+not\s+exist|is\s+not\s+in\s+this\s+registry/i.test(all)) return { errorType: 'not-found', message: `未找到包：请确认包名/版本存在` }
  if (/403|401|permission|unauthorized/i.test(all)) return { errorType: 'auth', message: '权限不足或包源拒绝访问' }
  if (/ETARGET|No\s+matching\s+version|no\s+matching/i.test(all)) return { errorType: 'version', message: '找不到匹配的版本（可能未发布或拼写错误）' }
  if (/ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS|Cannot remove.*no such dependency/i.test(all)) {
    return { errorType: 'not-installed', message: '该插件不是独立依赖（可能是官方内核 bundle），无法直接卸载' }
  }
  if (/resolve|ERR_PNPM|conflict|peer|ERESOLVE/i.test(all)) return { errorType: 'deps', message: '依赖解析/冲突，详见日志' }
  if (/timeout/i.test(all)) return { errorType: 'timeout', message: `安装超时（${PLUGIN_ACTION_TIMEOUT_MS / 1000}s），见日志` }
  return { errorType: 'other', message: r.stderr.trim() || r.stdout.trim() || '安装失败（无输出），见日志' }
}

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
    invalidatePortProbe(port)
    const { info, child } = spawnWebProfile({
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
        proc.error = diagnoseStartFailure(info.logFile, port)
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
    invalidatePortProbe(proc.port)
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
      ctx.sendJson(res, 403, { error: decision.reason, errorType: 'policy', message: decision.reason })
      return true
    }
    const r = await pluginAction(name, action as 'add' | 'remove' | 'update', pkg)
    const logFile = logPluginAction(ctx.logDir, name, action, pkg, r)
    const { errorType, message } = classifyPluginError(r)
    ctx.sendJson(res, r.ok ? 200 : 400, {
      ok: r.ok,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      errorType: r.ok ? 'ok' : errorType,
      message: r.ok ? '' : message,
      logFile: r.ok ? undefined : logFile,
    })
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
    const results: { pkg: string; ok: boolean; error?: string; errorType?: string; logFile?: string }[] = []
    for (const pkg of packages) {
      const p = typeof pkg === 'string' ? pkg.trim() : ''
      if (!p) {
        results.push({ pkg: String(pkg), ok: false, error: '空包名', errorType: 'other' })
        continue
      }
      const decision = sourcePolicy.check(p)
      if (!decision.allowed) {
        results.push({ pkg: p, ok: false, error: decision.reason, errorType: 'policy' })
        continue
      }
      try {
        const r = await pluginAction(name, 'add', p)
        const logFile = logPluginAction(ctx.logDir, name, 'add', p, r)
        const { errorType, message } = classifyPluginError(r)
        results.push(r.ok ? { pkg: p, ok: true } : { pkg: p, ok: false, error: message, errorType, logFile })
      } catch (err) {
        results.push({ pkg: p, ok: false, error: err instanceof Error ? err.message : String(err), errorType: 'other' })
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
