import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream, readdirSync } from 'node:fs'
import { spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { join } from 'node:path'
import { killProcess, runSync, spawnCommand } from './run.js'

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
 */
export function findPidByPort(port: number): number | null {
  if (process.platform === 'win32') {
    const r = runSync('netstat', ['-ano'])
    for (const line of r.stdout.split(/\r?\n/)) {
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
  const r = runSync('lsof', ['-ti', `tcp:${port}`])
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

  child.stdout?.on('data', (d) => {
    const text = d.toString()
    logStream.write(text)
    opts.onLog?.(text)
  })
  child.stderr?.on('data', (d) => {
    const text = d.toString()
    logStream.write(text)
    opts.onLog?.(text)
  })
  child.on('close', () => logStream.end())

  writeFileSync(pidFilePath(opts.pidDir, opts.port), String(child.pid ?? ''), 'utf8')

  const info: WebProcessInfo = {
    profile: opts.profile,
    port: opts.port,
    pid: child.pid ?? null,
    url: `http://127.0.0.1:${opts.port}`,
    pidFile: pidFilePath(opts.pidDir, opts.port),
    logFile,
    running: false,
  }

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

/** 反查某 pid 的进程名（Windows tasklist；其它平台返回 null）。 */
export function findProcessName(pid: number): string | null {
  if (process.platform !== 'win32') return null
  const r = runSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
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
 * 反查某个 Profile 当前在系统中运行的所有 dsh / node 进程 PID。
 * 通过匹配命令行参数 `--profile <profileName>` 实现全系统精准反查。
 */
export function findProcessesByProfile(profile: string): number[] {
  const pids: number[] = []
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeProfile) return pids

  if (process.platform === 'win32') {
    // 匹配命令行中包含 --profile <profile> 或 --profile "<profile>" 或 --profile '<profile>'
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match '--profile\\s+["\']?${safeProfile}["\']?(\\s|$)') } | Select-Object -ExpandProperty ProcessId`
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
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

  // POSIX 平台：pgrep -f
  const r = runSync('pgrep', ['-f', `--profile ${safeProfile}`])
  if (r.ok && r.stdout) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isFinite(pid) && pid > 0) {
        pids.push(pid)
      }
    }
  }
  return pids
}

/**
 * 彻底终止属于某 Profile 的所有运行中与孤儿进程，并清理其关联的 PID 文件与端口探测缓存。
 */
export async function killAllProfileProcesses(
  pidDir: string,
  profile: string,
): Promise<{ killed: number; pids: number[] }> {
  const pids = findProcessesByProfile(profile)
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

