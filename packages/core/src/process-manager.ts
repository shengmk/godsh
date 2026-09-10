import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream, readdirSync } from 'node:fs'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { join } from 'node:path'
import { killProcess, run, spawnCommand } from './run.js'

const execFileAsync = promisify(execFile)

export interface WebProcessStartOptions {
  profile: string
  port: number
  host?: string
  noOpen?: boolean
  /** 指定 dsh 版本的 node 入口（`node <dshBin> ...`）；缺省用 PATH 里的 dsh */
  dshBin?: string
  logDir: string
  pidDir: string
  readyTimeoutMs?: number
  onLog?: (line: string) => void
  /** 捕获到官方 dsh 输出的完整认证 URL 时的回调 */
  onUrlCaptured?: (url: string) => void
}

export interface WebProcessInfo {
  profile: string
  port: number
  pid: number | null
  url: string
  pidFile: string
  logFile: string
  running: boolean
}

/** 端口就绪探测缓存：2s TTL，避免 3s 轮询时每个 profile 反复发 HTTP 请求。 */
const portProbeCache = new Map<number, { at: number; listening: boolean }>()
const PORT_PROBE_TTL_MS = 2000

/** 在端口上探测 HTTP 服务是否就绪（带 2s 缓存）。 */
export function isPortListening(port: number, timeoutMs = 500): Promise<boolean> {
  const cached = portProbeCache.get(port)
  if (cached && Date.now() - cached.at < PORT_PROBE_TTL_MS) {
    return Promise.resolve(cached.listening)
  }
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume()
      const listening = res.statusCode !== undefined
      portProbeCache.set(port, { at: Date.now(), listening })
      resolve(listening)
    })
    req.on('timeout', () => {
      req.destroy()
      portProbeCache.set(port, { at: Date.now(), listening: false })
      resolve(false)
    })
    req.on('error', () => {
      portProbeCache.set(port, { at: Date.now(), listening: false })
      resolve(false)
    })
  })
}

/** 主动失效端口缓存（启动/停止后调用，避免旧值影响判活）。 */
export function invalidatePortProbe(port: number): void {
  portProbeCache.delete(port)
  netstatCache = null // netstat 快照同样失效，确保后续判活读到最新拓扑
}

/**
 * netstat 输出的短时快照缓存。
 *
 * 动机：端口协商（`resolveSafePort` / `findFreePort`）会对多个候选端口**连续**调用
 * `findPidByPort`，每次都派生一次 `netstat -ano`（Windows 上约 0.1–0.4s）。
 * 25 次重试意味着数秒的重复派生。500ms TTL 让同一轮协商只跑一次 netstat，
 * 既去掉阻塞又显著减少子进程数量。
 */
let netstatCache: { at: number; text: string } | null = null
const NETSTAT_TTL_MS = 500

async function readNetstatSnapshot(): Promise<string> {
  if (netstatCache && Date.now() - netstatCache.at < NETSTAT_TTL_MS) return netstatCache.text
  let text = ''
  try {
    const r = await run('netstat', ['-ano'], { timeoutMs: 8000 })
    text = r.ok ? r.stdout : ''
  } catch {
    text = ''
  }
  netstatCache = { at: Date.now(), text }
  return text
}

/** 轮询等待端口就绪。 */
export async function waitForPort(port: number, timeoutMs = 30000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return isPortListening(port)
}

function pidFilePath(pidDir: string, port: number): string {
  return join(pidDir, `service-pid-${port}.txt`)
}

function logFilePath(logDir: string, profile: string, port: number): string {
  return join(logDir, `dsh-${profile}-${port}.log`)
}

/** 读取某个端口的 pid 文件（不存在返回 null）。 */
export function readPidFile(pidDir: string, port: number): number | null {
  const p = pidFilePath(pidDir, port)
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

/**
 * 反查监听某端口的真实进程 pid。
 * 必要场景：Windows 上 `dsh` 走 cmd shim（`cmd.exe /c ...`），pid 文件记录的是 shim 的 pid；
 * shim 退出后真实 dsh（node）会被孤儿化但仍监听端口，此时只能按端口反查进程。
 *
 * ⚠️ 必须保持异步（R3b）：端口协商会对多个候选端口连续调用本函数，
 * 同步 netstat 会累积成数秒的事件循环阻塞（前端表现为「点击无响应」）。
 */
export async function findPidByPort(port: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const text = await readNetstatSnapshot()
    for (const line of text.split(/\r?\n/)) {
      const tokens = line.trim().split(/\s+/)
      if (tokens.length < 5) continue
      if (tokens[0] !== 'TCP' && tokens[0] !== 'TCPv6') continue
      if (tokens[3] !== 'LISTENING') continue
      const addrPort = Number.parseInt(tokens[1]?.split(':').at(-1) ?? '', 10)
      if (addrPort === port) {
        const pid = Number.parseInt(tokens[4] ?? '', 10)
        if (Number.isFinite(pid)) return pid
      }
    }
    return null
  }
  const r = await run('lsof', ['-ti', `tcp:${port}`], { timeoutMs: 8000 })
  const pid = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(pid) ? pid : null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 启动一个 Profile 的 dsh web 服务（不等待就绪，立即返回）。
 * 返回的 child 由调用方持有（或通过 stopWeb 按 pid 终止）。
 */
export function spawnWebProfile(opts: WebProcessStartOptions): { info: WebProcessInfo; child: ChildProcess } {
  mkdirSync(opts.logDir, { recursive: true })
  mkdirSync(opts.pidDir, { recursive: true })

  // 注意：dsh web 是 `--profile web` 的硬编码别名，不能接受 --profile。
  // 启动任意 Profile 的 Web UI 的正确姿势是 `dsh --profile <name> --port <port> --no-open`，
  // 其中 --port/--host/--no-open 是 Web App（dsh-web-app）的 flag，作为 inner args 传入。
  const args = ['--profile', opts.profile, '--port', String(opts.port)]
  if (opts.host) args.push('--host', opts.host)
  if (opts.noOpen !== false) args.push('--no-open')

  const logFile = logFilePath(opts.logDir, opts.profile, opts.port)
  const logStream = createWriteStream(logFile, { flags: 'w' })

  // 指定版本时直接 `node <dshBin> ...`（绕开 cmd shim，进程树更干净）；缺省走 PATH 的 dsh
  const command = opts.dshBin ? 'node' : 'dsh'
  const cmdArgs = opts.dshBin ? [opts.dshBin, ...args] : args

  const child = spawnCommand(command, cmdArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const info: WebProcessInfo = {
    profile: opts.profile,
    port: opts.port,
    pid: child.pid ?? null,
    // ⚠️ 不要在这里伪造 `http://127.0.0.1:<port>`：当前 dsh 的认证地址形如
    //    `http://127.0.0.1:<port>/?token=<...>`，无 token 的地址打开必然 401。
    //    伪造初值会让所有 `?? 兜底` 失效并把这个假值当成权威值传下去（bug 6 根因）。
    //    空串语义 = 「认证地址尚未就绪」。
    url: '',
    pidFile: pidFilePath(opts.pidDir, opts.port),
    logFile,
    running: false,
  }

  // stdout 可能把 URL 分块切开，保留尾部窗口参与匹配；并对同一 URL 只回调一次。
  let tail = ''
  const captureUrl = (text: string) => {
    const window = tail + text
    tail = window.slice(-512)
    const m = /dsh web:\s*(https?:\/\/[^\s\r\n]+)/.exec(window)
    if (m && m[1]) {
      const captured = m[1].replace(/[),;]+$/, '')
      if (captured !== info.url) {
        info.url = captured
        opts.onUrlCaptured?.(captured)
      }
    }
  }

  child.stdout?.on('data', (d) => {
    const text = d.toString()
    logStream.write(text)
    captureUrl(text)
    opts.onLog?.(text)
  })
  child.stderr?.on('data', (d) => {
    const text = d.toString()
    logStream.write(text)
    captureUrl(text)
    opts.onLog?.(text)
  })
  child.on('close', () => logStream.end())

  writeFileSync(pidFilePath(opts.pidDir, opts.port), String(child.pid ?? ''), 'utf8')

  return { info, child }
}

/** 启动 dsh web 并等待端口就绪。 */
export async function startWeb(opts: WebProcessStartOptions): Promise<{ info: WebProcessInfo; child: ChildProcess }> {
  const { info, child } = spawnWebProfile(opts)
  info.running = await waitForPort(opts.port, opts.readyTimeoutMs ?? 30000)
  return { info, child }
}

/** 停止某端口的 dsh web 服务（按 pid 文件 + 端口回退）。 */
export async function stopWeb(pidDir: string, port: number): Promise<{ ok: boolean; message: string }> {
  const pid = readPidFile(pidDir, port)
  if (pid && isProcessAlive(pid)) {
    const r = await killProcess(pid)
    if (r.ok) {
      rmSync(pidFilePath(pidDir, port), { force: true })
      return { ok: true, message: `已停止 pid ${pid}（端口 ${port}）` }
    }
    return { ok: false, message: `停止 pid ${pid} 失败: ${r.stderr}` }
  }
  // pid 文件缺失/失效（如 cmd shim 已退出但真实 dsh 被孤儿化）：按端口反查真实进程再终止
  const listenerPid = await findPidByPort(port)
  if (listenerPid) {
    const r = await killProcess(listenerPid)
    if (r.ok) {
      rmSync(pidFilePath(pidDir, port), { force: true })
      return { ok: true, message: `已按端口 ${port} 停止进程 pid ${listenerPid}` }
    }
    return { ok: false, message: `按端口 ${port} 停止失败: ${r.stderr}` }
  }
  rmSync(pidFilePath(pidDir, port), { force: true })
  return { ok: false, message: `端口 ${port} 没有正在运行的 dsh web 进程` }
}

/** 查询某端口的运行状态。 */
export async function getPortStatus(pidDir: string, port: number): Promise<{ running: boolean; pid: number | null }> {
  const pid = readPidFile(pidDir, port)
  if (pid && isProcessAlive(pid)) return { running: true, pid }
  return { running: false, pid: null }
}

/** 反查某 pid 的进程名（Windows tasklist；其它平台返回 null）。异步，避免阻塞事件循环。 */
export async function findProcessName(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 })
  if (!r.ok || !r.stdout) return null
  // tasklist CSV: "image.exe","pid","session","#","mem"
  const line = r.stdout.split(/\r?\n/)[0]?.trim()
  if (!line) return null
  const m = /^"([^"]+)"/.exec(line)
  return m?.[1] ?? null
}

/** 读取日志文件末尾若干行（用于诊断面板）。 */
export function readLogTail(logFile: string, maxLines = 200): string {
  if (!existsSync(logFile)) return ''
  try {
    const raw = readFileSync(logFile, 'utf8')
    const lines = raw.split(/\r?\n/)
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

/**
 * 从日志文件中提取 dsh web 启动时打印的带有认证 token 的 URL。
 * 例如：dsh web: http://127.0.0.1:3200/?token=abc123xyz
 */
export function extractDshWebUrl(logFile: string): string | null {
  if (!existsSync(logFile)) return null
  try {
    const raw = readFileSync(logFile, 'utf8')
    const matches = [...raw.matchAll(/dsh web:\s*(https?:\/\/[^\s\r\n]+)/g)]
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1]
      if (lastMatch && lastMatch[1]) {
        return lastMatch[1].replace(/[),;]+$/, '')
      }
    }
  } catch {}
  return null
}

/**
 * 该 URL 是否已带认证 token。
 *
 * 当前 dsh 的认证地址形如 `http://127.0.0.1:<port>/?token=<...>`；
 * **不带 token 的地址打开必然 401**，因此任何「回退到 host:port」的兜底都是错的。
 */
export function hasAuthToken(url: string | null | undefined): url is string {
  return typeof url === 'string' && /[?&]token=/.test(url)
}

/**
 * 等待 dsh 打印出认证 URL（用于「快速启动」直接给出可点链接，而不是先给一个 401 地址）。
 * 超时未拿到返回 null；`info.url` 会被 stdout 回调异步填充。
 */
export async function waitForWebUrl(
  info: WebProcessInfo,
  timeoutMs = 15_000,
  intervalMs = 300
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasAuthToken(info.url)) return info.url
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return hasAuthToken(info.url) ? info.url : null
}

/**
 * 反查某个 Profile 当前在系统中运行的所有 dsh / node 进程 PID。
 * 通过匹配命令行参数 `--profile <profileName>` 实现全系统精准反查。
 *
 * ⚠️ 必须保持异步（修复 R3 同类问题）：早期实现使用 `spawnSync` 同步执行
 * powershell/WMI 查询（超时 8000ms），而本函数在每次「启动 / 停止 / 重启 / 自愈」
 * 环境时都会被调用，会在此期间冻结整个单线程 HTTP 服务，
 * 前端表现为「点了没反应」。此处改为异步子进程。
 */
export async function findProcessesByProfile(profile: string): Promise<number[]> {
  const pids: number[] = []
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeProfile) return pids

  if (process.platform === 'win32') {
    // 性能大幅优化：在 WMI 阶段限制仅检索 node.exe 和 cmd.exe，避免全量序列化系统数千进程（单次耗时降低 95%）
    const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe' or Name = 'cmd.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match '--profile\\s+["\']?${safeProfile}["\']?(\\s|$)') } | Select-Object -ExpandProperty ProcessId`
    try {
      const r = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
      })
      if (r.stdout) {
        for (const line of r.stdout.split(/\r?\n/)) {
          const pid = Number.parseInt(line.trim(), 10)
          if (Number.isFinite(pid) && pid > 0) {
            pids.push(pid)
          }
        }
      }
    } catch {}
    return pids
  }

  // POSIX 平台：pgrep -f（异步）
  try {
    const r = await execFileAsync('pgrep', ['-f', `--profile ${safeProfile}`], { encoding: 'utf8' })
    if (r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const pid = Number.parseInt(line.trim(), 10)
        if (Number.isFinite(pid) && pid > 0) {
          pids.push(pid)
        }
      }
    }
  } catch {}
  return pids
}

/**
 * 彻底终止属于某 Profile 的所有运行中与孤儿进程，并清理其关联的 PID 文件与端口探测缓存。
 */
export async function killAllProfileProcesses(
  pidDir: string,
  profile: string,
): Promise<{ killed: number; pids: number[] }> {
  // 性能门控（回归修复）：WMI CommandLine 全系统扫描在本机实测需 3–5 秒
  // （旧文档所称「加 -Filter 后降到毫秒级」并不成立）。
  // 当 pidDir 下没有任何 service-pid-*.txt 时，说明本启动器从未为该环境登记过进程，
  // 此时全系统扫描没有可回收对象 —— 直接跳过。
  // 这修的是：全新环境首次启动 / 删除未启动过的环境被拖到 4–5 秒，
  // 恰好越过前端与冒烟脚本的 5 秒超时，导致请求被判失败且 running 尚未登记。
  const hasPidFiles = (() => {
    try {
      return existsSync(pidDir) && readdirSync(pidDir).some((f) => /^service-pid-\d+\.txt$/.test(f))
    } catch {
      return false
    }
  })()

  const pids = hasPidFiles ? await findProcessesByProfile(profile) : []
  for (const pid of pids) {
    await killProcess(pid)
  }

  // 扫描 pidDir 下的 service-pid-*.txt，清理已死亡进程或属于该 profile 的 pid 文件
  if (existsSync(pidDir)) {
    try {
      const files = readdirSync(pidDir)
      for (const file of files) {
        const match = /^service-pid-(\d+)\.txt$/.exec(file)
        if (match) {
          const port = Number.parseInt(match[1]!, 10)
          const recordedPid = readPidFile(pidDir, port)
          if (recordedPid && (pids.includes(recordedPid) || !isProcessAlive(recordedPid))) {
            rmSync(join(pidDir, file), { force: true })
            invalidatePortProbe(port)
          }
        }
      }
    } catch {
      /* 清理忽略异常 */
    }
  }
  return { killed: pids.length, pids }
}

