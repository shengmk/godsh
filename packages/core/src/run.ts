import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface RunResult {
  ok: boolean
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export interface RunOptions extends Omit<SpawnOptions, 'shell'> {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

const isWindows = process.platform === 'win32'

// cmd.exe 元字符：出现这些字符时需要用双引号包裹
const WIN_METACHARS = /[ \t"&|<>^()]/

function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (!WIN_METACHARS.test(arg)) return arg
  return '"' + arg.replace(/"/g, '""') + '"'
}

/** 将命令与参数拼成一条命令行（Windows 上逐参数转义）。 */
function buildCommandLine(command: string, args: string[]): string {
  if (!isWindows) return command
  return [command, ...args].map(quoteWinArg).join(' ')
}

/** 派生子进程：Windows 通过 cmd.exe 解析 .cmd shim，POSIX 直接 execvp。 */
function spawnProcess(command: string, args: string[], opts: RunOptions) {
  if (isWindows) {
    // shell + 单条命令字符串（无 args 数组），避免 DEP0190 且参数已转义
    return spawn(buildCommandLine(command, args), [], {
      shell: true,
      windowsHide: true,
      ...opts,
    })
  }
  return spawn(command, args, { ...opts })
}

/** 派生长驻子进程（不等待结束），返回 ChildProcess 供调用方管理。 */
export function spawnCommand(command: string, args: string[] = [], opts: RunOptions = {}): ChildProcess {
  return spawnProcess(command, args, opts)
}

/**
 * 执行一个外部命令并等待其结束。
 * Windows 上通过 cmd.exe（shell）解析 .cmd/.bat shim（dsh、pnpm 都是 .cmd shim）。
 */
export function run(command: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, stdout: stdout.trimEnd(), stderr: String(err) })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() })
    })
  })
}

/** 同步执行命令，用于轻量的版本探测。 */
export function runSync(command: string, args: string[] = [], opts: RunOptions = {}): RunResult {
  const r = isWindows
    ? spawnSync(buildCommandLine(command, args), [], {
        shell: true,
        windowsHide: true,
        encoding: 'utf8',
        ...opts,
      })
    : spawnSync(command, args, { encoding: 'utf8', ...opts })
  if (r.error) {
    return { ok: false, code: null, signal: null, stdout: '', stderr: String(r.error) }
  }
  return {
    ok: r.status === 0,
    code: r.status ?? null,
    signal: r.signal ?? null,
    stdout: (r.stdout ?? '').trimEnd(),
    stderr: (r.stderr ?? '').trimEnd(),
  }
}

/** 在 PATH 中查找命令的绝对路径（Windows 用 where，POSIX 用 which）。 */
export function findInPath(command: string): string | null {
  const which = isWindows ? 'where' : 'which'
  const r = runSync(which, [command])
  if (r.ok && r.stdout) {
    const line = r.stdout.split(/\r?\n/)[0]?.trim()
    if (line) return line
  }
  return null
}

/** 终止进程（Windows 用 taskkill /T 杀掉整棵进程树）。 */
export async function killProcess(pid: number): Promise<RunResult> {
  if (isWindows) {
    return run('taskkill', ['/PID', String(pid), '/T', '/F'])
  }
  try {
    process.kill(pid, 'SIGTERM')
    return { ok: true, code: 0, signal: null, stdout: '', stderr: '' }
  } catch (err) {
    return { ok: false, code: 1, signal: null, stdout: '', stderr: String(err) }
  }
}
