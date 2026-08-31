import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readLogTail, spawnWebProfile, stopWeb, waitForPort, isPortListening, findPidByPort, findProcessName, invalidatePortProbe, ensureProfileBundles, ensureCacheIntegrity, killAllProfileProcesses } from '@godsh/core'
import { createProfile, removeProfile, scanProfiles, setProfileBundles } from '@godsh/profile-manager'
import { pluginAction, PLUGIN_ACTION_TIMEOUT_MS, resolveInstallArg } from '@godsh/marketplace'
import type { ApiHandler, RouteContext, RuntimeProc } from './types.js'

/**
 * 启动串行队列：多个环境同时点「启动」时逐个执行，避免并发 spawn 的 dsh
 * 同时操作 profiles/node_modules fallback 导致 junction 竞争冲突
 * （"exists and is not a symlink" / EEXIST）。
 */
let startQueue: Promise<unknown> = Promise.resolve()
function enqueueStart<T>(task: () => Promise<T>): Promise<T> {
  const run = startQueue.then(task, task)
  startQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

/**
 * 启动失败诊断：读 dsh 日志，识别常见失败模式，给出可操作提示。
 * 返回给前端展示的 error 文案。
 */
function diagnoseStartFailure(logFile: string, port: number): string {
  try {
    const log = readLogTail(logFile, 200)
    const all = log || ''
    if (/YAMLException|bad indentation|cannot resolve profile bundle|failed to parse overlay|did not activate|pending \(waiting for service\)/i.test(all)) {
      return '环境配置（cordis.patch.yml）损坏、插件缺少 peer 依赖或 bundle 缺失。已自动修复 patch，若仍失败请检查该环境最近安装的插件是否缺少依赖（如 dsh-web-search-pro 需要 dsh-browser）'
    }
    if (/Cannot find package|ERR_MODULE_NOT_FOUND|failed to import loader entry/i.test(all)) {
      return 'DSH 官方依赖缓存被损坏（常见于安装插件时 pnpm 清空了 junction 目标）。已自动修复缓存，请重新启动环境'
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
  if (/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/i.test(all)) {
    return { errorType: 'release-age', message: '该插件（或其依赖）刚发布不足 1 天，被 pnpm 11 的供应链安全策略拒绝。godsh 已自动关闭该限制并重试，若仍失败请重试' }
  }
  if (/resolve|ERR_PNPM|conflict|peer|ERESOLVE/i.test(all)) return { errorType: 'deps', message: '依赖解析/冲突，详见日志' }
  if (/timeout/i.test(all)) return { errorType: 'timeout', message: `安装超时（${PLUGIN_ACTION_TIMEOUT_MS / 1000}s），见日志` }
  return { errorType: 'other', message: r.stderr.trim() || r.stdout.trim() || '安装失败（无输出），见日志' }
}

/**
 * 自动修复「最小发布年龄」策略拒绝安装的问题：
 * pnpm 11 默认要求包发布满 1 天（minimumReleaseAge: 1440 分钟）才能安装，
 * 新发布/刚更新的插件会报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION。
 * 该限制对 godsh 场景（用户装市场插件）没有价值，直接在该 profile 的
 * pnpm-workspace.yaml 写入 `minimumReleaseAge: 0` 关闭它。
 * @returns 是否写入了修复
 */
function disableReleaseAgeLimit(profilesDir: string, profile: string): boolean {
  const wsPath = join(profilesDir, profile, 'pnpm-workspace.yaml')
  try {
    if (!existsSync(wsPath)) return false
    let ws = readFileSync(wsPath, 'utf8')
    if (/^\s*minimumReleaseAge\s*:/m.test(ws)) return false // 已有，无需改
    const insertAt = ws.indexOf('allowBuilds:')
    if (insertAt >= 0) {
      ws = ws.slice(0, insertAt) + 'minimumReleaseAge: 0\n' + ws.slice(insertAt)
    } else {
      ws += '\nminimumReleaseAge: 0\n'
    }
    writeFileSync(wsPath, ws, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 判断 pnpm 输出是否命中「最小发布年龄」策略拒绝。 */
function isReleaseAgeError(r: { stdout: string; stderr: string }): boolean {
  return /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/i.test(`${r.stdout}\n${r.stderr}`)
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
      await stopWeb(pidDir, proc.port)
      invalidatePortProbe(proc.port)
      running.delete(name)
      ctx.persistRuntime()
    }
    await killAllProfileProcesses(pidDir, name)
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
    await enqueueStart(async () => {
      const existing = running.get(name)
      const allowMulti = config.webKernel.allowMultiPort === true

      // 默认严格单环境单端口模式：若已在运行或有残留旧进程，强制先终止旧进程并释放旧端口
      if (!allowMulti) {
        if (existing) {
          await stopWeb(pidDir, existing.port)
          invalidatePortProbe(existing.port)
          running.delete(name)
        }
        await killAllProfileProcesses(pidDir, name)
      } else if (existing && existing.status !== 'error') {
        ctx.sendJson(res, 409, { error: `Profile "${name}" 已在运行` })
        return
      }

      if (existing) running.delete(name)
      // 启动前确保该 profile 的官方 bundle 就绪（自愈 + fallback 预建，防并发冲突）
      try {
        ensureProfileBundles(ctx.env.dshHome, name)
      } catch {
        /* 自愈失败不阻断，dsh 会尽力启动 */
      }
      // 启动前修复被 pnpm 清空的缓存包（junction 目标），防 Cannot find package
      try {
        const integrity = ensureCacheIntegrity()
        if (integrity.healed > 0) console.log(`[godsh] 启动前缓存自愈: ${integrity.message}`)
      } catch {
        /* 缓存修复失败不阻断，dsh 会给出具体报错 */
      }
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
    })
    return true
  }

  // POST /api/profiles/:name/restart
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'restart' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    await enqueueStart(async () => {
      const existing = running.get(name)
      if (existing) {
        await stopWeb(pidDir, existing.port)
        invalidatePortProbe(existing.port)
        running.delete(name)
      }
      await killAllProfileProcesses(pidDir, name)
      ctx.persistRuntime()

      // 短暂等待 OS 释放 socket 端口
      await new Promise((r) => setTimeout(r, 400))

      try {
        ensureProfileBundles(ctx.env.dshHome, name)
      } catch {}
      try {
        ensureCacheIntegrity()
      } catch {}
      ctx.ensureUnifiedKernel(name)

      const basePort = Number(body.port) || existing?.port || config.webKernel.defaultPort || 3080
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
    })
    return true
  }

  // POST /api/profiles/:name/stop
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'stop' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const proc = running.get(name)
    if (proc) {
      await stopWeb(pidDir, proc.port)
      invalidatePortProbe(proc.port)
      running.delete(name)
    }
    // 强制彻底清理该 profile 的所有孤儿进程
    await killAllProfileProcesses(pidDir, name)
    ctx.persistRuntime()
    ctx.sendJson(res, 200, { ok: true, message: `已停止 ${name} 及释放所有关联端口` })
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

  // POST /api/profiles/:name/plugins  { action, pkg, marketName? }
  if (seg.length === 3 && seg[0] === 'profiles' && seg[2] === 'plugins' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const action = body.action as string
    let pkg = body.pkg as string
    // marketName：市场展示名（可能 ≠ 可安装包名，如 "dsh-trail#bundle" / github: 源）。
    // 提供时从市场索引解析真实安装参数（npm 字段 → install 字段 → name 去 #）。
    if (typeof body.marketName === 'string' && body.marketName.trim()) {
      try {
        const plugins = (await ctx.getMarket()) as Array<{ name?: string; npm?: string; install?: string }>
        const mp = plugins.find((p) => p.name === body.marketName)
        const resolved = resolveInstallArg(mp)
        if (resolved) pkg = resolved
      } catch {
        /* 市场解析失败时回退用原 pkg */
      }
    }
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
    // 卸载容错：目标包名不在 dependencies（如市场 npm 字段 ≠ 实际安装名）时，
    // 自动查找该环境已安装依赖中匹配的包名重试（如 @furongjun1999/dsh-memory ↔ dsh-memory）
    let effective = pkg
    let result = r
    if (action === 'remove' && !r.ok && /ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS|no such dependency/i.test(`${r.stdout}\n${r.stderr}`)) {
      const installed = scanProfiles(profilesDir).find((p) => p.name === name)?.dependencies ?? {}
      const match = Object.keys(installed).find(
        (dep) => dep === pkg || dep.endsWith('/' + pkg) || pkg.endsWith('/' + dep) || dep.replace(/^@[^/]+\//, '') === pkg.replace(/^@[^/]+\//, ''),
      )
      if (match) {
        effective = match
        result = await pluginAction(name, 'remove', match)
      }
    }
    // git-hosted 包构建容错：pnpm 要求把 git 包加入 allowBuilds（key 是 包名@URL）。
    // 解析报错提示的 key，写入 profile 的 pnpm-workspace.yaml 后重试一次。
    if (action === 'add' && !result.ok && /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(`${result.stdout}\n${result.stderr}`)) {
      const all = `${result.stdout}\n${result.stderr}`
      const keyMatch = /allowBuilds:\s*\n\s*(@?[^\s]+@https?:\/\/\S+):\s*true/.exec(all) || /The git-hosted package "([^"]+)" needs to execute build scripts/.exec(all)
      if (keyMatch) {
        const pkgKey = keyMatch[1]!.trim()
        const wsPath = join(profilesDir, name, 'pnpm-workspace.yaml')
        try {
          if (existsSync(wsPath)) {
            let ws = readFileSync(wsPath, 'utf8')
            if (!ws.includes(pkgKey)) {
              // 在 allowBuilds 块内追加（无 allowBuilds 则创建）
              // key 含 URL(: 字符), YAML 需引号包裹
              const quoted = /[\s:#]/.test(pkgKey) ? `"${pkgKey.replace(/"/g, '\\"')}"` : pkgKey
              if (/allowBuilds:/.test(ws)) {
                ws = ws.replace(/(allowBuilds:\s*\n)/, `$1  ${quoted}: true\n`)
              } else {
                ws += `\nallowBuilds:\n  ${quoted}: true\n`
              }
              writeFileSync(wsPath, ws, 'utf8')
              // 重试一次
              result = await pluginAction(name, 'add', pkg)
              effective = pkg
            }
          }
        } catch {
          /* 写 allowBuilds 失败则保留原错误 */
        }
      }
    }
    // 最小发布年龄策略容错：pnpm 11 默认拒绝安装「发布不足 1 天」的包
    // （ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）。godsh 场景下用户装市场插件
    // 期望立即可装，自动在该 profile 的 workspace 关闭限制并重试一次。
    if (action === 'add' && !result.ok && isReleaseAgeError(result)) {
      if (disableReleaseAgeLimit(profilesDir, name)) {
        result = await pluginAction(name, 'add', pkg)
        effective = pkg
      }
    }
    const logFile = logPluginAction(ctx.logDir, name, action, effective, result)
    const { errorType, message } = classifyPluginError(result)
    ctx.sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      errorType: result.ok ? 'ok' : errorType,
      message: result.ok ? '' : message,
      logFile: result.ok ? undefined : logFile,
    })
    return true
  }

  // POST /api/profiles/:name/plugins/uninstall  { pkg } —— 智能卸载：
  // 1) 若 pkg 是 dependencies（用户安装的），走 dsh plugin remove（连带 reconcile bundles）；
  // 2) 若 pkg 只在 bundles（官方内核 bundle / 无依赖的 bundle），从 dsh.profile.bundles 移除，
  //    让该 bundle 不再被加载（等效于"删除"），而不是报 400。
  if (seg.length === 4 && seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'uninstall' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const pkg = typeof body.pkg === 'string' ? body.pkg.trim() : ''
    if (!pkg) {
      ctx.sendJson(res, 400, { error: 'body 需要 { pkg }' })
      return true
    }
    const profile = scanProfiles(profilesDir).find((p) => p.name === name)
    const deps = profile?.dependencies ?? {}
    const bundles = profile?.bundles ?? []

    // 硬保护：@deepseek-ai/dsh-base 是每个 profile 的核心内核，删除后环境完全无法启动
    if (pkg === '@deepseek-ai/dsh-base') {
      ctx.sendJson(res, 400, { ok: false, errorType: 'protected', message: 'dsh-base 是核心内核 bundle，不能卸载（环境依赖它才能启动）' })
      return true
    }

    // 情况 1：dependencies 里有该包（或可匹配的）→ dsh plugin remove
    // 注意：必须用「匹配到的真实依赖名」执行 remove —— 市场 npm 字段名(如 @furongjun1999/dsh-memory)
    // 可能 ≠ 实际安装名(如 dsh-memory)，用 pkg 直接 remove 会报 no such dependency
    const matchedDep = Object.keys(deps).find(
      (d) => d === pkg || d.endsWith('/' + pkg) || pkg.endsWith('/' + d),
    )
    if (matchedDep) {
      const r = await pluginAction(name, 'remove', matchedDep)
      const logFile = logPluginAction(ctx.logDir, name, 'remove', matchedDep, r)
      const { errorType, message } = classifyPluginError(r)
      if (r.ok) {
        ctx.sendJson(res, 200, { ok: true, removed: matchedDep, method: 'pnpm' })
        return true
      }
      ctx.sendJson(res, 400, { ok: false, code: r.code, errorType, message, logFile })
      return true
    }

    // 情况 2：只在 bundles → 从 bundles 移除（不再加载），并同步清理 patch 里的残留条目
    if (bundles.includes(pkg)) {
      const next = bundles.filter((b) => b !== pkg)
      setProfileBundles(profilesDir, name, next)
      // 同步清理 patch 中的该 bundle 条目（若 launcher 分配机制写过）
      try {
        const patchPath = join(profilesDir, name, 'cordis.patch.yml')
        if (existsSync(patchPath)) {
          const raw = readFileSync(patchPath, 'utf8')
          const cleaned = raw
            .split(/\r?\n/)
            .filter((line) => !line.includes(`id: "${pkg}"`) && !line.includes(`id: ${pkg}`))
          // 若只剩 "- insert:" 或空, 写空数组
          let final = cleaned
          if (final.every((l) => !l.trim() || l.trim() === '- insert:')) final = ['[]']
          writeFileSync(patchPath, final.join('\n') + '\n', 'utf8')
        }
      } catch {
        /* 忽略 patch 清理失败 */
      }
      ctx.sendJson(res, 200, { ok: true, removed: pkg, method: 'bundle' })
      return true
    }

    // 两者都没有：给出友好提示
    ctx.sendJson(res, 404, { ok: false, errorType: 'not-installed', message: `该插件不在环境 ${name} 中，无需卸载` })
    return true
  }

  // POST /api/profiles/:name/plugins/batch  { packages: string[], marketNames?: string[] }
  if (seg.length === 4 && seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'batch' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const packages = body.packages as unknown
    if (!Array.isArray(packages) || packages.length === 0) {
      ctx.sendJson(res, 400, { error: 'body 需要 { packages: string[] }' })
      return true
    }
    // marketNames：与 packages 对应的市场展示名（用于解析 github:/http-tgz 等真实安装参数）
    const marketNames = Array.isArray(body.marketNames) ? (body.marketNames as unknown[]) : []
    let marketMap: Map<string, string> | null = null
    if (marketNames.some((m) => typeof m === 'string' && m)) {
      try {
        const plugins = (await ctx.getMarket()) as Array<{ name?: string; npm?: string; install?: string }>
        marketMap = new Map()
        for (const p of plugins) {
          if (p && typeof p.name === 'string') {
            const resolved = resolveInstallArg(p)
            if (resolved) marketMap.set(p.name, resolved)
          }
        }
      } catch {
        marketMap = null
      }
    }
    const results: { pkg: string; ok: boolean; error?: string; errorType?: string; logFile?: string }[] = []
    // 最小发布年龄策略：首次命中后自动关闭限制，后续包不再失败
    let releaseAgeFixed = false
    for (let i = 0; i < packages.length; i++) {
      let p = typeof packages[i] === 'string' ? (packages[i] as string).trim() : ''
      // 用市场名解析真实安装参数（若提供了 marketNames）
      if (marketMap && i < marketNames.length && typeof marketNames[i] === 'string') {
        const resolved = marketMap.get(marketNames[i] as string)
        if (resolved) p = resolved
      }
      if (!p) {
        results.push({ pkg: String(packages[i]), ok: false, error: '空包名', errorType: 'other' })
        continue
      }
      const decision = sourcePolicy.check(p)
      if (!decision.allowed) {
        results.push({ pkg: p, ok: false, error: decision.reason, errorType: 'policy' })
        continue
      }
      try {
        let r = await pluginAction(name, 'add', p)
        // 命中「发布不足 1 天」策略：自动关闭限制并重试一次（全局一次性）
        if (!r.ok && isReleaseAgeError(r) && !releaseAgeFixed) {
          if (disableReleaseAgeLimit(profilesDir, name)) {
            releaseAgeFixed = true
            r = await pluginAction(name, 'add', p)
          }
        }
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

  // POST /api/profiles/:name/plugins/update-all —— 更新该环境全部已安装依赖（后台任务 + 进度）
  if (seg.length === 4 && seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'update-all' && method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '')
    const profile = scanProfiles(profilesDir).find((p) => p.name === name)
    const deps = Object.keys(profile?.dependencies ?? {})
    if (deps.length === 0) {
      ctx.sendJson(res, 200, { profile: name, task: null, ok: 0, failed: 0, message: '该环境没有可更新的插件' })
      return true
    }
    // 后台任务：串行更新每个插件，进度写入日志，前端轮询 GET /api/profiles/:name/plugins/update-all/progress
    const taskKey = `update-all-${name}-${Date.now()}`
    ctx.startInstallTask(taskKey, `update-all-${name}-${Date.now()}.log`, async (log) => {
      log(`开始更新环境 ${name}（共 ${deps.length} 个插件）\n`)
      let i = 0
      for (const pkg of deps) {
        i++
        log(`\n[${i}/${deps.length}] 更新 ${pkg} ...\n`)
        try {
          const r = await pluginAction(name, 'update', pkg)
          log(r.ok ? `✓ ${pkg} 更新成功\n` : `✗ ${pkg} 更新失败：${r.stdout || r.stderr}\n`)
        } catch (err) {
          log(`✗ ${pkg} 更新失败：${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
      log(`\n全部完成 ✅\n`)
    })
    ctx.sendJson(res, 202, { profile: name, task: taskKey, ok: 0, failed: 0, message: '开始更新' })
    return true
  }

  // GET /api/profiles/:name/plugins/update-all/progress —— 轮询后台更新进度
  if (seg.length === 5 && seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'update-all' && seg[4] === 'progress' && method === 'GET') {
    const task = String(url.searchParams.get('task') ?? '')
    const view = task ? ctx.installTaskView(task) : null
    if (!view) {
      ctx.sendJson(res, 404, { error: '任务不存在' })
      return true
    }
    ctx.sendJson(res, 200, view)
    return true
  }

  return false
}
