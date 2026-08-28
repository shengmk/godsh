import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findInPath, runSync } from './run.js'
import type { DshInstance, EnvInfo, ToolInfo } from './types.js'

function detectTool(command: string, versionArgs: string[]): ToolInfo {
  const path = findInPath(command)
  const r = runSync(command, versionArgs)
  const version = r.ok ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null
  return {
    found: r.ok,
    path,
    version,
    error: r.ok ? undefined : (r.stderr || `命令 "${command}" 不可用`),
  }
}

export interface DetectOptions {
  /** 显式覆盖 DSH_HOME（默认读 config.json 的 dsh.home 或 $DSH_HOME 或 ~/.dsh）。 */
  dshHome?: string
  /** Profile 目录名（相对 DSH_HOME，默认 "profiles"）。 */
  profilesDirName?: string
}

/** 检测运行环境：node / pnpm / dsh 与 DSH_HOME。 */
export function detectEnvironment(opts: DetectOptions = {}): EnvInfo {
  const node: ToolInfo = { found: true, path: process.execPath, version: process.version }
  const pnpm = detectTool('pnpm', ['--version'])
  const dsh = detectTool('dsh', ['--version'])

  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profilesDirName = opts.profilesDirName ?? 'profiles'
  const profilesDir = join(dshHome, profilesDirName)

  const errors: string[] = []
  if (!pnpm.found) errors.push('未找到 pnpm，请先安装 pnpm')
  if (!dsh.found) errors.push('未找到 dsh CLI，请先安装 DeepSeek Harness')
  if (!existsSync(dshHome)) errors.push(`DSH_HOME 不存在: ${dshHome}`)
  if (!existsSync(profilesDir)) errors.push(`profiles 目录不存在: ${profilesDir}`)

  return {
    platform: process.platform,
    node,
    pnpm,
    dsh,
    dshHome,
    dshHomeExists: existsSync(dshHome),
    profilesDir,
    profilesDirExists: existsSync(profilesDir),
    errors,
  }
}

/** 从 dsh 包目录解析可直接 `node <entry>` 运行的入口（bin 或 lib/bin.js）。 */
function readPackageEntry(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
    const candidates = [bin ? join(pkgDir, bin) : '', join(pkgDir, 'lib', 'bin.js')]
    for (const c of candidates) if (c && existsSync(c)) return c
    return null
  } catch {
    return null
  }
}

/**
 * 检测本机安装的多个 dsh 版本：
 * 1. PATH 里的 dsh（where dsh 全部匹配，含 .cmd/.ps1 shim → 反解 npm 包目录）
 * 2. npm / pnpm 全局根（node_modules/@deepseek-ai/dsh）
 * 3. 用户配置的额外目录（extraDirs，package.json 目录）
 * 每个实例给出可直接 `node <run>` 的入口与版本号。
 */
export function findDshInstances(extraDirs: string[] = []): DshInstance[] {
  const out = new Map<string, DshInstance>()
  const add = (name: string, path: string, run: string | null) => {
    if (!run || out.has(name)) return
    // 同一入口去重（如 npm 目录里裸 dsh 与 dsh.cmd 指向同一个包）
    for (const existing of out.values()) if (existing.run === run) return
    out.set(name, { name, path, run, version: null })
  }

  if (process.platform === 'win32') {
    const whereLines = runSync('where', ['dsh'])
      .stdout.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    // 1) .cmd/.bat/.ps1 shim（优先，通常能正确反解包目录）
    for (const p of whereLines) {
      if (!/\.(cmd|bat|ps1)$/i.test(p)) continue
      const pkgDir = join(dirname(p), 'node_modules', '@deepseek-ai', 'dsh')
      add(`path:${p}`, p, readPackageEntry(pkgDir))
    }
    // 2) 无扩展名条目（npm 目录里的裸 dsh 文件）：同样先尝试反解包目录，失败再按可执行文件
    for (const p of whereLines) {
      if (/\.(cmd|bat|ps1)$/i.test(p)) continue
      const entry = readPackageEntry(join(dirname(p), 'node_modules', '@deepseek-ai', 'dsh'))
      if (entry) add(`path:${p}`, p, entry)
      else if (existsSync(p)) add(`path:${p}`, p, p)
    }
  }

  for (const pkgMgr of ['npm', 'pnpm'] as const) {
    const r = runSync(pkgMgr, ['root', '-g'])
    const root = r.stdout.trim()
    if (!root) continue
    const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    add(`${pkgMgr}-global`, pkgDir, readPackageEntry(pkgDir))
  }

  for (const d of extraDirs) {
    if (d && existsSync(join(d, 'package.json'))) add(`dir:${d}`, d, readPackageEntry(d))
  }

  for (const inst of out.values()) {
    const r = runSync('node', [inst.run, '--version'])
    inst.version = r.ok ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null
  }
  return [...out.values()]
}
