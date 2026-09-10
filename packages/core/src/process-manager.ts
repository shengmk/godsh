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

export interface WebProbeResult {
  /** 只要收到了 HTTP 响应就算活着（200 / 303 / 401 都算），连接被重置或超时算失败 */
  ok: boolean
  statusCode: number | null
  /** 失败原因；ok 为 true 时为 null */
  reason: string | null
}

/**
 * 探活：端口在监听**不等于**进程活着。
 *
 * 实测事故（2026-09-10，webtest 环境）：dsh 已经打印出带 token 的地址（所以前端先显示「启动成功」），
 * 但**第一个 HTTP 请求**就让它在 `WebServer.gzip` 里抛出 `TypeError: invalid media type` 且无人捕获，
 * 进程直接退出 —— 端口随即消失，界面翻回「未启动」。
 * 也就是说，只探测「端口是否监听」的判定**必然会先误报一次成功**。
 *
 * 刻意带上 `Accept-Encoding`：正是这个头部触发了那次崩溃，不带它探活等于没探。
 */
export async function probeWebUrl(url: string, timeoutMs = 5000): Promise<WebProbeResult> {
  return await new Promise<WebProbeResult>((resolveProbe) => {
    let settled = false
    const finish = (r: WebProbeResult): void => {
      if (settled) return
      settled = true
      resolveProbe(r)
    }
    try {
      const u = new URL(url)
      const req = http.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'accept-encoding': 'gzip, deflate, br', accept: 'text/html,*/*' },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume()
          res.on('end', () => finish({ ok: true, statusCode: res.statusCode ?? null, reason: null }))
          res.on('error', (e: Error) => finish({ ok: false, statusCode: null, reason: `响应中断：${e.message}` }))
        }
      )
      req.on('timeout', () => {
        finish({ ok: false, statusCode: null, reason: `请求在 ${timeoutMs}ms 内无响应` })
        try {
          req.destroy()
        } catch {
          /* 已断开 */
        }
      })
      req.on('error', (e: Error) => finish({ ok: false, statusCode: null, reason: `连接失败：${e.message}` }))
      req.end()
    } catch (e) {
      finish({ ok: false, statusCode: null, reason: e instanceof Error ? e.message : String(e) })
    }
  })
}

/**
 * 构造「按 Profile 反查进程」的 PowerShell 查询串（导出仅为可回归测试）。
 *
 * 性能结论（本机 Windows PowerShell 5.1 实测，2026-09-10）：
 * 同一查询**加上 `-Property ProcessId,CommandLine`** 后，
 * 最坏耗时 3796 ms → 487 ms（单次最坏 7879 ms → 730 ms），命中结果完全一致。
 * 慢的原因不是 WMI 枚举本身，而是 `Get-CimInstance` 默认要为每个命中进程
 * 构造并序列化**全部属性**的 CIM 对象；只索取这两个属性即可绕开这部分开销。
 *
 * 为什么不改用 `netstat -ano`：netstat 全量实测 44–233 ms，确实更快，
 * 但它只能回答「端口 ↔ PID」，无法回答「该 PID 的命令行里有没有这个 --profile」。
 * 若改成按监听端口反查，会漏掉尚未绑定端口、或已停止监听但进程仍活着的残留进程，
 * stop / restart 就杀不干净。因此保留 WMI，只做属性裁剪。
 */
export function buildProfileProcessQuery(profile: string): string | null {
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeProfile) return null
  // 注意 `["'']`：PowerShell 的单引号字符串里，字面量单引号必须写成两个单引号。
  // 曾经写成 `["']`，导致整条命令语法错误（"Unexpected token ']'"），
  // 而调用处的 `catch {}` 把错误吞掉，于是本函数在 Windows 上「永远返回空数组、还白等 3–8 秒」。
  return `Get-CimInstance Win32_Process -Property ProcessId,CommandLine -Filter "Name = 'node.exe' or Name = 'cmd.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match '--profile\\s+["'']?${safeProfile}["'']?(\\s|$)') } | Select-Object -ExpandProperty ProcessId`
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
    // 性能：查询串只索取 ProcessId 与 CommandLine（见 buildProfileProcessQuery 的实测结论）
    const psCmd = buildProfileProcessQuery(safeProfile)
    if (!psCmd) return pids
    try {
      const r = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        encoding: 'utf8',
        // 超时给足 20 秒：本机实测 powershell.exe 冷启动本身就要 3.2–7.3 秒，
        // 原先的 8000ms 几乎没有余量 —— 机器一忙就顶到超时，被 catch 吞成「空数组」，
        // 于是「深扫」在负载下静默失效（这也是它历史上看起来一直没用的第二个原因）。
        // 该函数如今只被 deep: true 的后台自愈路径调用，放宽超时不占用交互路径。
        timeout: 20_000,
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
    } catch (e) {
      // 不许静默：正因为这里曾经是空 catch，查询串的语法错误（见 buildProfileProcessQuery）
      // 才被隐藏了很久，表现为「清理残留进程永远无效，还白等 3–8 秒」。
      console.warn('[process-manager] findProcessesByProfile 查询失败（返回空结果）:', e instanceof Error ? e.message : String(e))
    }
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
 * 读取 pidDir/runtime.json 里某个 Profile 最近登记的端口（免 PowerShell 的端口来源之一）。
 * runtime.json 由 server.ts 维护，结构为 `{ entries: [{ profile, port, startedAt, url? }] }`。
 */
function readRuntimePorts(pidDir: string, profile: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(join(pidDir, 'runtime.json'), 'utf8')) as {
      entries?: { profile?: string; port?: number }[]
    }
    return (raw.entries ?? [])
      .filter((e) => e?.profile === profile && typeof e.port === 'number' && e.port > 0)
      .map((e) => e.port as number)
  } catch {
    return []
  }
}

/** `killAllProfileProcesses` 的可选项。 */
export interface KillProfileOptions {
  /**
   * 本次调用方**已知属于该 Profile** 的端口。
   * 传入后，定位残留进程只需读 pid 文件 + 查 netstat 快照（约 0.1 秒，完全不 spawn PowerShell）。
   */
  ports?: number[]
  /**
   * 是否额外执行「按 `--profile` 匹配命令行」的全系统扫描。
   *
   * ⚠️ 该扫描在 Windows 上必须 spawn 一次 `powershell.exe`，
   * 而本机实测 `powershell.exe -NoProfile -NonInteractive -Command "1"`（空跑）
   * 就要 3.2–7.3 秒（`Get-CimInstance` 的 `-Property` 裁剪只能省下其中约 0.5 秒，救不了大局）。
   * 因此默认关闭，只留给自愈等后台流程；启动 / 停止 / 删除路径一律走端口快路径。
   */
  deep?: boolean
}

/**
 * 终止属于某 Profile 的残留进程，并清理其关联的 PID 文件与端口探测缓存。
 *
 * 定位策略（?06 重写；主体行为不变，只把「慢的定位手段」换成「快的」）：
 * 1. **端口快路径（默认，免 PowerShell）**：对调用方给出的每个端口，
 *    既取 pid 文件里登记的 PID，也取 netstat 快照里**当前真正监听该端口**的 PID。
 *    后者正是仓库里已记录的孤儿形态——`dsh` 在 Windows 上走 cmd shim，
 *    shim 退出后真实 dsh（node）被孤儿化但仍占着端口（同类逻辑见 `stopWeb` 与 `findPidByPort`）。
 *    `killProcess` 用 `taskkill /T`，会连带杀掉子树。
 * 2. **深扫（`deep: true`，仅后台流程）**：额外按 `--profile <name>` 匹配命令行全系统反查，
 *    用于「端口信息缺失」或「自愈要求清干净」的场景。
 *
 * 为什么不无条件用深扫：那是启动 / 停止 / 删除路径上 3–8 秒的固定开销，
 * 曾把冒烟脚本与前端 5 秒超时顶爆，用户看到的是「点了没反应」。
 */
export async function killAllProfileProcesses(
  pidDir: string,
  profile: string,
  opts: KillProfileOptions = {},
): Promise<{ killed: number; pids: number[] }> {
  const found = new Set<number>()

  // 1) 端口快路径：pid 文件登记的 PID + 真正占用该端口的 PID（netstat 快照有 500ms 缓存）。
  //    端口来源 = 调用方给出的（最准）+ pidDir/runtime.json 里该 Profile 最近登记的。
  const ports = new Set<number>(opts.ports ?? [])
  for (const p of readRuntimePorts(pidDir, profile)) ports.add(p)
  for (const port of ports) {
    if (!Number.isFinite(port) || port <= 0) continue
    const recorded = readPidFile(pidDir, port)
    if (recorded && isProcessAlive(recorded)) found.add(recorded)
    const owner = await findPidByPort(port)
    if (owner) found.add(owner)
  }

  // 2) 深扫（可选）：按 --profile 匹配命令行
  if (opts.deep) {
    for (const pid of await findProcessesByProfile(profile)) found.add(pid)
  }

  const pids = Array.from(found)
  for (const pid of pids) {
    await killProcess(pid)
  }

  // 扫描 pidDir 下的 service-pid-*.txt：清理「本次已终止」或「进程已死亡」的登记文件。
  // 注意 pidDir 是**全 Profile 共享**的（context.ts 里 pidDir = data/runtime），
  // 因此绝不能按「文件存在」就杀，只能按上面的端口归属判断。
  if (existsSync(pidDir)) {
    try {
      const files = readdirSync(pidDir)
      for (const file of files) {
        const match = /^service-pid-(\d+)\.txt$/.exec(file)
        if (match) {
          const port = Number.parseInt(match[1]!, 10)
          const recordedPid = readPidFile(pidDir, port)
          if (recordedPid && (found.has(recordedPid) || !isProcessAlive(recordedPid))) {
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

