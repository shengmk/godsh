import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { MONOREPO_ROOT, findPidByPort, isPortListening, readLogTail } from '@dsh-launcher/core'
import { fetchMarketIndex } from '@dsh-launcher/marketplace'
import { scanProfiles } from '@dsh-launcher/profile-manager'
import type { CliContext } from './context.js'
import { routeHandlers } from './routes/index.js'
import type { ApiHandler, RouteContext, RuntimeProc } from './routes/types.js'

interface RuntimeStateFile {
  entries: { profile: string; port: number; startedAt: number }[]
}

/** 运行状态持久化文件：pidDir/runtime.json，用于 API 服务重启后恢复仍在运行的 dsh 进程。 */
function runtimeStatePath(pidDir: string): string {
  return join(pidDir, 'runtime.json')
}

function readRuntimeState(pidDir: string): RuntimeStateFile['entries'] {
  try {
    const parsed = JSON.parse(readFileSync(runtimeStatePath(pidDir), 'utf8')) as RuntimeStateFile
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

function writeRuntimeState(pidDir: string, entries: RuntimeStateFile['entries']): void {
  mkdirSync(pidDir, { recursive: true })
  writeFileSync(runtimeStatePath(pidDir), JSON.stringify({ entries }, null, 2) + '\n', 'utf8')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** 安全响应头：始终附加（即使无 CORS 头）。 */
function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  }
}

/** 根据配置的允许来源生成 CORS 头；未配置（仅同源）时不返回任何 CORS 头。 */
function corsHeaders(allowedOrigins: string[]): Record<string, string> {
  if (!allowedOrigins.length) return {}
  return {
    'Access-Control-Allow-Origin': allowedOrigins.join(','),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (d) => (raw += d.toString()))
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
  })
}

export interface ApiServerOptions {
  port: number
  host?: string
}

/**
 * dsh Launcher HTTP API 服务：
 * - /api/* 按资源域分派到 routes/ 下的 handler（见 routeHandlers）
 * - 其它路径回退到 apps/shell-web/dist 的静态资源（若已构建）
 */
export async function startApiServer(ctx: CliContext, opts: ApiServerOptions): Promise<http.Server> {
  const { store, env, profilesDir, pidDir, logDir, pluginsDir, templatesDir, kernels, allocations, unifiedKernel, dshEnvs, sourcePolicy } = ctx
  const config = store.readConfig()

  // 会话内运行中的 dsh web 进程（profile → 进程）
  const running = new Map<string, RuntimeProc>()

  // 恢复上次会话遗留的运行进程：从 runtime.json 回读。
  // 判活以「端口就绪」为准（与 profileView/status 语义一致）：
  // Windows 上 pid 文件记录的是 cmd shim 的 pid，API 服务重启后 shim 已退出、
  // 真实 dsh（node）被孤儿化但仍在监听端口，因此不能只依赖 pid 文件。
  for (const e of readRuntimeState(pidDir)) {
    if (running.has(e.profile)) continue
    if (await isPortListening(e.port)) {
      running.set(e.profile, { port: e.port, child: null, startedAt: e.startedAt, status: 'running' })
    }
  }

  /** 将当前运行表持久化到 runtime.json（start/stop/进程退出时调用）。 */
  function persistRuntime(): void {
    writeRuntimeState(
      pidDir,
      [...running.entries()].map(([profile, p]) => ({ profile, port: p.port, startedAt: p.startedAt })),
    )
  }

  /**
   * 启动前把统一内核应用到某 Profile（幂等）：
   * 将 web-app + 用户偏好插件并入该 Profile 的 dsh.profile.bundles，
   * 保证没有 web-app 的 Profile 也能启动出 Web UI。
   */
  function ensureUnifiedKernel(profile: string): void {
    const p = scanProfiles(profilesDir).find((x) => x.name === profile)
    if (p) unifiedKernel.applyToProfile(p)
  }

  /** 解析某 Profile 应使用的 dsh 版本（node 入口）；无配置时返回 undefined（走 PATH 的 dsh）。 */
  function resolveDshBin(profile?: string): string | undefined {
    const cfg = store.readConfig()
    const name = (profile && cfg.dsh.byProfile?.[profile]) || cfg.dsh.activeVersion || ''
    if (!name) return undefined
    return cfg.dsh.instances?.[name]
  }

  /**
   * 分配关系变更后自动写回该 Profile 的 cordis.patch.yml。
   * 写回失败（如 patch 含无法解析的结构）时返回错误信息，由路由层决定回滚策略。
   */
  function tryApplyAllocation(
    profile: string,
    removedIds?: string[],
  ): { applied: boolean; patchPath?: string; applyError?: string } {
    try {
      const path = allocations.applyProfile(profilesDir, profile, removedIds)
      return { applied: true, patchPath: path }
    } catch (err) {
      return { applied: false, applyError: err instanceof Error ? err.message : String(err) }
    }
  }

  // 市场索引缓存（5 分钟）；用可变引用供 routes/market 共享
  let marketCache: { at: number; plugins: unknown[] } | null = null

  async function getMarket(): Promise<unknown[]> {
    if (marketCache && Date.now() - marketCache.at < 5 * 60_000) return marketCache.plugins
    if (!config.pluginMarket.enabled) return []
    const index = await fetchMarketIndex(config.pluginMarket.indexUrl)
    marketCache = { at: Date.now(), plugins: index.plugins }
    return index.plugins
  }

  async function findFreePort(base: number): Promise<number> {
    for (let port = base; port < base + 100; port++) {
      if (!(await isPortListening(port))) return port
    }
    throw new Error('找不到可用端口')
  }

  /**
   * 轻量运行状态视图（合并轮询用）：只读取运行表中的端口/状态，
   * 不扫描磁盘上的 Profile 详情，避免 3s 轮询造成 IO 开销。
   */
  async function profileStatusView(name: string) {
    const proc = running.get(name)
    let runningState = false
    let starting = false
    let port: number | null = null
    let pid: number | null = null
    let procError: string | null = null
    if (proc) {
      port = proc.port
      if (proc.child === null) {
        // 从 runtime.json 恢复的进程没有 child 引用：以端口就绪为准，pid 按端口反查真实进程
        runningState = await isPortListening(proc.port)
        pid = runningState ? findPidByPort(proc.port) : null
      } else {
        starting = proc.status === 'starting'
        runningState = proc.status === 'running'
        pid = proc.child.pid ?? null
        if (proc.status === 'error') procError = proc.error ?? '启动失败，请查看日志'
      }
    }
    return {
      name,
      running: runningState,
      starting,
      port,
      pid,
      procError,
      url: runningState && port !== null ? `http://127.0.0.1:${port}` : null,
    }
  }

  async function profileView(name: string) {
    const p = scanProfiles(profilesDir).find((x) => x.name === name)
    const st = await profileStatusView(name)
    return {
      ...st,
      exists: Boolean(p),
      bundles: p?.bundles ?? [],
      dependencies: p?.dependencies ?? {},
      patchEntries: p?.patchEntries ?? 0,
      patchDisabled: p?.patchDisabled ?? [],
      error: p?.error ?? null,
    }
  }

  // 后台安装任务（base 安装 / 并列环境安装）：key → 状态 + 日志文件
  const installTasks = new Map<string, { status: 'running' | 'done' | 'error'; logFile: string; message?: string }>()

  /** 启动一个后台安装任务；进度写入 logDir 下的日志文件，供前端轮询。 */
  function startInstallTask(key: string, logName: string, job: (log: (line: string) => void) => Promise<void>): void {
    const logFile = join(logDir, logName)
    mkdirSync(logDir, { recursive: true })
    writeFileSync(logFile, '', 'utf8')
    const rec: { status: 'running' | 'done' | 'error'; logFile: string; message?: string } = { status: 'running', logFile }
    installTasks.set(key, rec)
    const log = (line: string) => {
      try {
        writeFileSync(logFile, line, { flag: 'a' })
      } catch {
        /* 忽略写日志失败 */
      }
    }
    void (async () => {
      try {
        await job(log)
        rec.status = 'done'
      } catch (err) {
        rec.status = 'error'
        rec.message = err instanceof Error ? err.message : String(err)
      }
    })()
  }

  function installTaskView(key: string): { status: string; log: string; message?: string } | null {
    const rec = installTasks.get(key)
    if (!rec) return null
    return { status: rec.status, message: rec.message, log: readLogTail(rec.logFile, 200) }
  }

  // 允许跨域来源（默认空 = 仅同源）；设置页保存后即时更新
  const allowedOriginsRef: { value: string[] } = { value: config.allowedOrigins ?? [] }

  /** 路由共享上下文（不可变装配，运行态通过 Map/引用对象共享）。 */
  const routeCtx: RouteContext = {
    store,
    env,
    profilesDir,
    pidDir,
    logDir,
    pluginsDir,
    templatesDir,
    kernels,
    allocations,
    unifiedKernel,
    dshEnvs,
    sourcePolicy,
    config,
    running,
    installTasks,
    marketCache,
    allowedOrigins: allowedOriginsRef,
    sendJson(res, status, data) {
      const body = JSON.stringify(data)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(allowedOriginsRef.value),
        ...securityHeaders(),
      })
      res.end(body)
    },
    persistRuntime,
    ensureUnifiedKernel,
    resolveDshBin,
    tryApplyAllocation,
    getMarket,
    findFreePort,
    profileStatusView,
    profileView,
    startInstallTask,
    installTaskView,
  }

  /** 分派到各 route handler；全部未命中返回 404。 */
  const dispatch: ApiHandler = async (_ctx, req, res, method, seg, body, url) => {
    for (const handler of routeHandlers) {
      if (await handler(routeCtx, req, res, method, seg, body, url)) return true
    }
    return false
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    // CORS 预检（仅对配置了允许来源时放行；同源场景直接 204）
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(allowedOriginsRef.value),
        ...securityHeaders(),
      })
      return res.end()
    }

    if (pathname.startsWith('/api/')) {
      try {
        const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean)
        const body = method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT' ? await readBody(req) : {}

        // GET /api/health
        if (seg.length === 1 && seg[0] === 'health') {
          routeCtx.sendJson(res, 200, {
            launcher: config.launcher,
            dshHome: env.dshHome,
            profilesDir: env.profilesDir,
            node: env.node,
            pnpm: env.pnpm,
            dsh: env.dsh,
            errors: env.errors,
          })
          return
        }

        const handled = await dispatch(routeCtx, req, res, method, seg, body, url)
        if (!handled) routeCtx.sendJson(res, 404, { error: `未知接口: ${method} ${pathname}` })
      } catch (err) {
        routeCtx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // 静态资源
    await serveStatic(res, pathname)
  })

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const distDir = join(MONOREPO_ROOT, 'apps', 'shell-web', 'dist')
    let filePath = join(distDir, pathname === '/' ? 'index.html' : pathname)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA 回退到 index.html
      filePath = join(distDir, 'index.html')
    }
    if (!existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() })
      res.end('dsh Launcher API 服务运行中。前端尚未构建：请在 apps/shell-web 运行 pnpm build。\n')
      return
    }
    const ext = extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...securityHeaders() })
    res.end(readFileSync(filePath))
  }

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve))
  console.log(`dsh Launcher API: http://${opts.host ?? '127.0.0.1'}:${opts.port}`)
  return server
}
