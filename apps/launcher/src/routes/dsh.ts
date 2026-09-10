import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DATA_DIR, readLogTail, stopWeb, safePurgeProfileJunctions, defaultJournal } from '@godsh/core'
import { DshEnvManager } from '@godsh/dsh-env'
import { removeProfile, scanProfiles } from '@godsh/profile-manager'
import type { ApiHandler } from './types.js'

/** /api/dsh*、/api/dsh-envs* —— DSH 本体状态 / 安装 / 并列环境 */
export const dshHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { store, dshEnvs, pidDir, running, installTasks } = ctx

  // POST /api/dsh/refresh - 强制刷新探测缓存
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'refresh' && method === 'POST') {
    DshEnvManager.invalidateCache()
    ctx.sendJson(res, 200, { ok: true, message: '已刷新环境与版本缓存' })
    return true
  }

  // POST /api/dsh/tasks/clear - 清理已结束的任务日志
  if (seg.length === 3 && seg[0] === 'dsh' && seg[1] === 'tasks' && seg[2] === 'clear' && method === 'POST') {
    for (const [k, rec] of installTasks.entries()) {
      if (rec.status !== 'running') installTasks.delete(k)
    }
    ctx.sendJson(res, 200, { ok: true })
    return true
  }

  // GET /api/dsh/status
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'status' && method === 'GET') {
    const st = await dshEnvs.status()
    const tasks = [...installTasks.entries()].map(([key, rec]) => ({
      key,
      status: rec.status,
      message: rec.message ?? null,
      log: readLogTail(rec.logFile, 200),
    }))
    ctx.sendJson(res, 200, { ...st, tasks, activeVersionName: store.readConfig().dsh.activeVersion ?? '' })
    return true
  }

  // GET /api/dsh/versions
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'versions' && method === 'GET') {
    ctx.sendJson(res, 200, { published: await dshEnvs.publishedVersions(), local: await dshEnvs.detectedInstances() })
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
      envs: await dshEnvs.list(),
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
      const env = await dshEnvs.activate(id)
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
        safePurgeProfileJunctions(home)
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

  // GET /api/dsh/desktop-status —— 查询 DSH Desktop 安装状态与路径
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'desktop-status' && method === 'GET') {
    const exe = findDshDesktopExe()
    ctx.sendJson(res, 200, { installed: Boolean(exe), path: exe })
    return true
  }

  // POST /api/dsh/open-desktop { profile } —— 同步状态并启动 DSH Desktop 官方客户端
  if (seg.length === 2 && seg[0] === 'dsh' && seg[1] === 'open-desktop' && method === 'POST') {
    const profile = typeof body.profile === 'string' ? body.profile.trim() : ''
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }
    const exe = findDshDesktopExe()
    if (!exe) {
      ctx.sendJson(res, 404, { error: '未检测到已安装的 DSH Desktop 客户端' })
      return true
    }

    // 1. 契约门禁：规范化 bundles 顺序并移除 launcher-owned
    sanitizeProfileForDshDesktop(ctx.profilesDir, profile)

    // 2. 写入官方选定状态 state.json
    writeDshDesktopState(profile)

    // 3. 注入 DSH_HOME 唤醒 DSH Desktop.exe
    const envVars: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP_DEFAULT_PROFILE: profile }
    if (ctx.env.dshHome) {
      envVars.DSH_HOME = ctx.env.dshHome
    }
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      env: envVars,
    })
    child.unref()

    defaultJournal.log({
      level: 'info',
      category: 'desktop-launch',
      profile,
      action: '唤醒 DSH Desktop 客户端',
      status: 'success',
      details: `已写入选定状态并启动 ${exe}`,
      operator: 'user',
    })

    ctx.sendJson(res, 200, { ok: true, profile, exe })
    return true
  }

  return false
}

function findDshDesktopExe(): string | null {
  const local = process.env.LOCALAPPDATA || ''
  const standard = join(local, 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
  if (existsSync(standard)) return standard

  const appdata = process.env.APPDATA || ''
  const shim = join(appdata, 'DSH Desktop', 'host-commands', 'desktop', 'bin', 'dsh.cmd')
  if (existsSync(shim)) {
    try {
      const text = readFileSync(shim, 'utf8')
      const start = text.indexOf('DSH Desktop.exe')
      if (start > 0) {
        const before = text.slice(0, start)
        const quote = before.lastIndexOf('"')
        if (quote >= 0) {
          const exe = before.slice(quote + 1) + 'DSH Desktop.exe'
          const cleaned = exe.replace(/\\\\/g, '\\')
          if (existsSync(cleaned)) return cleaned
        }
      }
    } catch {}
  }
  return null
}

function writeDshDesktopState(profile: string): void {
  const appdata = process.env.APPDATA || ''
  if (!appdata) return
  const dir = join(appdata, 'DSH Desktop', 'profile-selection')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, active: profile }, null, 2) + '\n', 'utf8')
}

function sanitizeProfileForDshDesktop(profilesDir: string, profile: string): void {
  const pkgPath = join(profilesDir, profile, 'package.json')
  if (!existsSync(pkgPath)) return
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg.dsh) pkg.dsh = {}
    if (!pkg.dsh.profile) pkg.dsh.profile = {}
    let bundles: string[] = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : []
    bundles = bundles.filter((b) => b !== 'dsh-plugin-desktop' && b !== 'dsh-plugin-desktop-beta')
    bundles = bundles.filter((b) => b !== '@deepseek-ai/dsh-base' && b !== '@deepseek-ai/dsh-web-app')
    bundles.unshift('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
    pkg.dsh.profile.bundles = bundles
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  } catch {}
}
