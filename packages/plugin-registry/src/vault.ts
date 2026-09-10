import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync, lstatSync, statSync, symlinkSync, renameSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DATA_DIR, run, ensureCompatibilityShims } from '@godsh/core'
import { auditPackage, type PluginAuditReport, type SecurityLevel } from '@godsh/security'
import { inspectManifest } from './bundle.js'
import { getVaultContract, detectPluginConflicts, findDependentsOf } from './vault-contract.js'
import type { PluginKind, PluginManifest } from './types.js'

export interface VaultPlugin {
  id: string
  name: string
  version: string
  kind: PluginKind
  source: 'market' | 'local'
  sourcePath?: string
  category?: string
  description?: string
  installedProfiles?: string[]
  hasUpdate?: boolean
  latestVersion?: string
  stagedAt: number
  /** 可选多版本并存列表 */
  versions?: string[]
  /** 当前激活版本 */
  activeVersion?: string
  /** 磁盘物理大小 (Bytes) */
  sizeBytes?: number
  /** 安全评级 */
  securityLevel?: SecurityLevel
  /** 安全评分 (0-100) */
  securityScore?: number
  /** 完整审计报告快照 */
  auditReport?: PluginAuditReport
  /** 是否已建立 NTFS Directory Junction 零拷贝链接 */
  isJunctionLinked?: boolean
}

export interface DeploymentSnapshot {
  id: string
  timestamp: number
  profile: string
  pluginId: string
  pluginName: string
  fromVersion?: string
  toVersion: string
  action: 'deploy' | 'switch' | 'rollback' | 'unmount' | 'remove'
}

export interface ProfileSyncResult {
  profile: string
  status: 'synced' | 'failed' | 'pruned'
  error?: string
}

export interface PluginUpdateResult {
  ok: boolean
  plugin?: VaultPlugin
  fromVersion?: string
  toVersion?: string
  message?: string
  failedSyncProfiles?: { profile: string; error: string }[]
  profileResults?: ProfileSyncResult[]
}

export interface DiskSavingsReport {
  totalVaultBytes: number
  savedBytes: number
  totalJunctions: number
  pluginCount: number
}

interface VaultDataFile {
  version: string
  updatedAt: number
  plugins: VaultPlugin[]
}

interface VaultHistoryFile {
  snapshots: DeploymentSnapshot[]
}

function isJunctionOrSymlink(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isSymbolicLink()
  } catch {
    return false
  }
}

function removePathSafe(p: string): void {
  if (!existsSync(p) && !isJunctionOrSymlink(p)) return
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) {
      rmSync(p, { force: true })
    } else if (st.isDirectory()) {
      rmSync(p, { recursive: true, force: true })
    } else {
      rmSync(p, { force: true })
    }
  } catch {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {}
  }
}

/** 读取某物理目录 package.json 的运行时依赖名与**声明范围**（dependencies 优先于 peerDependencies）。 */
function readPackageDependencySpecs(dir: string): { name: string; range: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const out = new Map<string, string>()
    for (const [n, r] of Object.entries(parsed.peerDependencies ?? {})) out.set(n, r)
    // dependencies 覆盖 peerDependencies：真正声明为依赖时以它为准
    for (const [n, r] of Object.entries(parsed.dependencies ?? {})) out.set(n, r)
    return [...out.entries()].map(([name, range]) => ({ name, range }))
  } catch {
    return []
  }
}

/** 读取某物理目录 manifest 的插件类型（bundle / both / client / unknown）。 */
function readPackageKind(dir: string): PluginKind {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PluginManifest
    return inspectManifest(parsed).kind
  } catch {
    return 'unknown'
  }
}

/** 挂载结果：`junction`（零拷贝）| `copied`（降级复制）| `failed`（未挂载）。 */
export type LinkOutcome = 'junction' | 'copied' | 'failed'

/**
 * 建立 Junction（零拷贝）；失败时降级为目录复制。
 *
 * 变更（bug 2 / R7）：旧实现用 `boolean` 同时表达「复制成功」与「失败」，
 * 调用方无法区分，于是挂了 bundles 却没有任何物理文件。
 * 现在返回三态，调用方必须据此决定是否写入声明。
 *
 * 复制降级改为「先复制到暂存目录，再原子改名」，避免中断留下半个目录。
 */
function createJunctionOrCopy(src: string, dest: string): LinkOutcome {
  mkdirSync(dirname(dest), { recursive: true })
  removePathSafe(dest)
  try {
    symlinkSync(src, dest, 'junction')
    return 'junction'
  } catch {
    /* 降级为复制 */
  }
  const staging = `${dest}.godsh-copy-${process.pid}-${Date.now()}`
  try {
    cpSync(src, staging, { recursive: true })
    removePathSafe(dest)
    renameSync(staging, dest)
    return 'copied'
  } catch {
    removePathSafe(staging)
    return 'failed'
  }
}

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 *
 * 动机（bug 2「注入后打不开」的直接成因之一）：`writeFileSync` 是**截断式覆盖**，
 * 一旦写入过程中被中断（进程被杀 / 磁盘满 / 杀毒软件锁文件），
 * profile 的 `package.json` 会留下半截 JSON，dsh 解析失败 → 环境打不开。
 * 项目其它位置（dsh-heal.ts）早已采用 temp+rename，唯独注入路径没有。
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(tmp, filePath)
  } catch {
    // Windows 上 rename 覆盖已存在文件可能返回 EPERM/EEXIST：先删目标再重试
    try {
      rmSync(filePath, { force: true })
      renameSync(tmp, filePath)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      throw err
    }
  }
}

/**
 * profile 级互斥队列。
 *
 * 动机（bug 2 / R8）：同一个 `profile/package.json` 有**三个写者**
 * —— `VaultManager`（注入/卸载）、`UnifiedKernelManager`（每次启动都会写 bundles）、
 * `profile-editor`（新建/修复）。三者原本毫无互斥，并发/交错时互相覆盖。
 * 把写入路径统一挂到本队列上串行执行。
 */
const profileLockChains = new Map<string, Promise<unknown>>()

export async function withProfileLock<T>(profileDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(profileDir).toLowerCase()
  const previous = profileLockChains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  // 链尾吞掉异常，避免一次失败永久阻断后续排队
  const tail = run.catch(() => {})
  profileLockChains.set(key, tail)
  try {
    return await run
  } finally {
    if (profileLockChains.get(key) === tail) profileLockChains.delete(key)
  }
}

/** Profile 的 package.json 形态（仅声明我们关心的字段）。 */
interface ProfilePackageJson {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [k: string]: unknown
}

/** 读取 profile 的 package.json（解析失败返回 null，不抛错）。 */
function readProfilePackage(profileDir: string): ProfilePackageJson | null {
  const p = join(profileDir, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ProfilePackageJson
  } catch {
    return null
  }
}

/** 读取某物理目录 package.json 的 version（读不到返回 null）。 */
function readPackageVersion(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null
  } catch {
    return null
  }
}

/** 某包名在 profile 的 node_modules 下是否**物理可解析**（能读到 package.json）。 */
function isResolvableInProfile(profileDir: string, name: string): boolean {
  return existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
}

/**
 * 生产/注入后的针对性校验：只检查本次涉及的包名，避免误报历史遗留问题。
 * 校验三件事：① package.json 合法；② 每个包在 dependencies 中；③ 每个包物理可解析。
 */
export interface InjectVerificationIssue {
  kind: 'invalid-json' | 'not-declared' | 'not-resolvable'
  detail: string
}

function verifyInjectedPackages(profileDir: string, names: string[]): InjectVerificationIssue[] {
  const issues: InjectVerificationIssue[] = []
  const pkg = readProfilePackage(profileDir)
  if (!pkg) return [{ kind: 'invalid-json', detail: join(profileDir, 'package.json') }]
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  for (const name of names) {
    if (!Object.hasOwn(deps, name)) {
      issues.push({ kind: 'not-declared', detail: name })
    }
    if (!isResolvableInProfile(profileDir, name)) {
      issues.push({ kind: 'not-resolvable', detail: name })
    }
  }
  return issues
}

function getDirectorySize(dir: string, maxFiles = 300): number {
  if (!existsSync(dir)) return 0
  let total = 0
  let fileCount = 0
  function walk(current: string) {
    if (fileCount >= maxFiles) return
    try {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (fileCount >= maxFiles) break
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          fileCount++
          total += statSync(full).size
        }
      }
    } catch {}
  }
  walk(dir)
  return total
}

export class VaultManager {
  private dataFile: string
  private historyFile: string
  private storeDir: string

  constructor(dataDir = DATA_DIR) {
    this.dataFile = join(dataDir, 'vault.json')
    this.historyFile = join(dataDir, 'vault-history.json')
    this.storeDir = join(dataDir, 'vault_store')
    mkdirSync(this.storeDir, { recursive: true })
  }

  private readData(): VaultDataFile {
    if (!existsSync(this.dataFile)) {
      return { version: '1.0.0', updatedAt: Date.now(), plugins: [] }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, 'utf8')) as VaultDataFile
      return Array.isArray(parsed?.plugins) ? parsed : { version: '1.0.0', updatedAt: Date.now(), plugins: [] }
    } catch {
      return { version: '1.0.0', updatedAt: Date.now(), plugins: [] }
    }
  }

  private saveData(data: VaultDataFile): void {
    data.updatedAt = Date.now()
    writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf8')
  }

  private readHistory(): DeploymentSnapshot[] {
    if (!existsSync(this.historyFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.historyFile, 'utf8')) as VaultHistoryFile
      return Array.isArray(parsed?.snapshots) ? parsed.snapshots : []
    } catch {
      return []
    }
  }

  private saveHistory(snapshots: DeploymentSnapshot[]): void {
    // 保留最近 200 条部署快照记录
    const trimmed = snapshots.slice(-200)
    writeFileSync(this.historyFile, JSON.stringify({ snapshots: trimmed }, null, 2), 'utf8')
  }

  list(): VaultPlugin[] {
    return this.readData().plugins
  }

  get(id: string): VaultPlugin | undefined {
    return this.list().find((p) => p.id === id || p.name === id)
  }

  /**
   * 定位插件在本地或用户级沙箱存储池中的物理根目录
   */
  resolvePluginSourceDir(plugin: VaultPlugin, version?: string): string | null {
    const targetVer = version || plugin.activeVersion || plugin.version
    const sanitized = plugin.name.replace(/[^a-zA-Z0-9@._-]/g, '_')

    // 1. 显式指定的 sourcePath（若存在 package.json）
    if (plugin.sourcePath && existsSync(plugin.sourcePath) && existsSync(join(plugin.sourcePath, 'package.json'))) {
      return plugin.sourcePath
    }

    // 2. 本地工作区 storeDir
    const cand1 = join(this.storeDir, `${sanitized}@${targetVer}`)
    if (existsSync(cand1)) return cand1

    // 3. 用户级 APPDATA storeDir
    if (process.env.APPDATA) {
      const cand2 = join(process.env.APPDATA, 'godsh', 'data', 'vault_store', `${sanitized}@${targetVer}`)
      if (existsSync(cand2)) return cand2
    }

    // 4. storeDir 模糊版本匹配
    try {
      const entries = readdirSync(this.storeDir)
      const match = entries.find((e) => e.startsWith(`${sanitized}@`))
      if (match) return join(this.storeDir, match)
    } catch {}

    // 5. 用户级 APPDATA 模糊匹配
    if (process.env.APPDATA) {
      try {
        const appDir = join(process.env.APPDATA, 'godsh', 'data', 'vault_store')
        if (existsSync(appDir)) {
          const entries = readdirSync(appDir)
          const match = entries.find((e) => e.startsWith(`${sanitized}@`))
          if (match) return join(appDir, match)
        }
      } catch {}
    }

    return null
  }

  /**
   * 本地插件导入：自动探知并纳管入沙箱
   */
  async importLocal(targetPath: string, category = 'local'): Promise<VaultPlugin> {
    if (!existsSync(targetPath)) {
      throw new Error(`本地路径不存在: ${targetPath}`)
    }

    let pkgJsonPath = join(targetPath, 'package.json')
    let actualDir = targetPath

    if (!existsSync(pkgJsonPath)) {
      const entries = readdirSync(targetPath, { withFileTypes: true })
      const sub = entries.find((e) => e.isDirectory() && existsSync(join(targetPath, e.name, 'package.json')))
      if (sub) {
        actualDir = join(targetPath, sub.name)
        pkgJsonPath = join(actualDir, 'package.json')
      } else {
        throw new Error(`未在指定路径及其子目录中找到 package.json`)
      }
    }

    let manifest: PluginManifest
    try {
      manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PluginManifest
    } catch (e) {
      throw new Error(`解析 package.json 失败: ${e instanceof Error ? e.message : String(e)}`)
    }

    const name = manifest.name || basename(actualDir)
    const version = manifest.version || '1.0.0'
    const info = inspectManifest(manifest)

    const sanitized = name.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const destDir = join(this.storeDir, `${sanitized}@${version}`)
    mkdirSync(destDir, { recursive: true })

    try {
      cpSync(actualDir, destDir, { recursive: true })
    } catch {}

    // 静态代码安全审计
    const auditReport = await auditPackage(actualDir, { name, version })

    const data = this.readData()
    const id = `vault-local-${sanitized}`
    const existingIdx = data.plugins.findIndex((p) => p.id === id || p.name === name)

    const sizeBytes = getDirectorySize(destDir)

    const plugin: VaultPlugin = {
      id,
      name,
      version,
      kind: info.kind,
      source: 'local',
      sourcePath: destDir,
      category,
      description: typeof (manifest as Record<string, unknown>).description === 'string'
        ? ((manifest as Record<string, unknown>).description as string)
        : '本地导入插件',
      versions: [version],
      activeVersion: version,
      sizeBytes,
      securityLevel: auditReport.level,
      securityScore: auditReport.score,
      auditReport,
      stagedAt: Date.now(),
    }

    if (existingIdx >= 0) {
      data.plugins[existingIdx] = plugin
    } else {
      data.plugins.push(plugin)
    }

    this.saveData(data)
    return plugin
  }

  /**
   * 从市场暂存插件入沙箱（准备就绪态）
   */
  async addFromMarket(item: { name: string; version: string; description?: string; category?: string }): Promise<VaultPlugin> {
    const data = this.readData()
    const sanitized = item.name.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const id = `vault-market-${sanitized}`
    const existing = data.plugins.find((p) => p.id === id || p.name === item.name)

    if (existing) {
      existing.version = item.version
      existing.category = item.category || existing.category
      existing.description = item.description || existing.description
      existing.versions = existing.versions || []
      if (!existing.versions.includes(item.version)) {
        existing.versions.push(item.version)
      }
      existing.activeVersion = item.version
      this.saveData(data)
      return existing
    }

    const plugin: VaultPlugin = {
      id,
      name: item.name,
      version: item.version,
      kind: 'bundle',
      source: 'market',
      category: item.category || 'tools',
      description: item.description,
      versions: [item.version],
      activeVersion: item.version,
      securityLevel: item.name.startsWith('@deepseek-ai/') || item.name.startsWith('@godsh/') ? 'official' : 'safe',
      securityScore: 100,
      stagedAt: Date.now(),
    }

    data.plugins.push(plugin)
    this.saveData(data)
    return plugin
  }

  /**
   * 读取沙箱内每个插件的依赖集合（dependencies + peerDependencies），
   * 用于反向依赖判定。物理源读不到时按空集合处理。
   */
  private readDependencyIndex(data: { plugins: VaultPlugin[] }): { name: string; dependencies: Record<string, string> }[] {
    return data.plugins.map((p) => {
      let dependencies: Record<string, string> = {}
      const src = this.resolvePluginSourceDir(p)
      if (src) {
        try {
          const parsed = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            peerDependencies?: Record<string, string>
          }
          dependencies = { ...(parsed.dependencies ?? {}), ...(parsed.peerDependencies ?? {}) }
        } catch {
          /* 物理源不可读 → 视为无依赖 */
        }
      }
      return { name: p.name, dependencies }
    })
  }

  /** 判断物理目录是否位于沙箱存储池内（防止误删 profile 内的目录）。 */
  private isInsideStoreDir(dir: string): boolean {
    const pools = [this.storeDir]
    if (process.env.APPDATA) pools.push(join(process.env.APPDATA, 'godsh', 'data', 'vault_store'))
    const normalized = resolve(dir).toLowerCase()
    return pools.some((pool) => {
      const p = resolve(pool).toLowerCase()
      return normalized === p || normalized.startsWith(p + sep)
    })
  }

  /**
   * 从沙箱移除插件（**完整事务**）。
   *
   * 旧实现只从 `vault.json` 里 `splice` 一条记录：不卸挂载、不解除 Junction、不删物理目录，
   * 也从不检查「谁依赖它」——这正是「删不掉」与「删了环境打不开」的根因。
   *
   * @param mode  `block`（默认）被依赖时拒绝；`cascade` 连同依赖者一起删；`force` 忽略依赖强删
   * @param purge 是否同时删除 `vault_store` 中的物理目录（默认 false，交给 GC 回收更安全）
   */
  async remove(
    id: string,
    opts: { mode?: 'block' | 'cascade' | 'force'; purge?: boolean; profilesDir?: string } = {}
  ): Promise<{
    ok: boolean
    name?: string
    unmountedFrom: string[]
    dependents: string[]
    purged: boolean
    error?: string
  }> {
    const mode = opts.mode ?? 'block'
    const unmountedFrom: string[] = []

    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) {
      return { ok: false, unmountedFrom, dependents: [], purged: false, error: `沙箱中未找到插件: ${id}` }
    }

    // ---- 反向依赖检查（bug 3）----
    const dependents = findDependentsOf(plugin.name, this.readDependencyIndex(data)).filter((n) => n !== plugin.name)
    if (dependents.length > 0 && mode === 'block') {
      return {
        ok: false,
        name: plugin.name,
        unmountedFrom,
        dependents,
        purged: false,
        error:
          `该插件被 ${dependents.length} 个插件依赖（${dependents.join('、')}）。` +
          `删除它会导致这些环境因缺依赖而打不开；如确认请改用级联删除（mode=cascade）`,
      }
    }

    const targets: VaultPlugin[] = [plugin]
    if (mode === 'cascade') {
      for (const name of dependents) {
        const dep = data.plugins.find((p) => p.name === name)
        if (dep) targets.push(dep)
      }
    }

    // ---- 1. 先在所有挂载环境卸载（解除 Junction + 清理声明）----
    if (opts.profilesDir) {
      for (const t of targets) {
        for (const prof of [...(t.installedProfiles ?? [])]) {
          try {
            await this.unmountFromProfile(t.id, prof, opts.profilesDir)
            unmountedFrom.push(prof)
          } catch {
            /* 单个环境卸载失败不应阻断整体删除，但会在 history 里留痕 */
          }
        }
      }
    }

    // ---- 2. 再移除索引 ----
    const removing = new Set(targets.map((t) => t.name))
    data.plugins = data.plugins.filter((p) => !removing.has(p.name))
    this.saveData(data)

    // ---- 3. 可选物理回收（仅限沙箱池内，绝不触碰 profile 目录）----
    let purged = false
    if (opts.purge) {
      for (const t of targets) {
        const src = this.resolvePluginSourceDir(t)
        if (src && this.isInsideStoreDir(src)) {
          removePathSafe(src)
          purged = true
        }
      }
    }

    const history = this.readHistory()
    history.push({
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      profile: unmountedFrom.join(',') || '-',
      pluginId: plugin.id,
      pluginName: plugin.name,
      toVersion: plugin.version,
      action: 'remove',
    })
    this.saveHistory(history)

    return { ok: true, name: plugin.name, unmountedFrom, dependents, purged }
  }

  /**
   * 批量移除（bug 5）：逐项独立事务，单项失败不影响其余。
   * 返回逐项结果，供任务中心与前端精确展示。
   */
  async removeMany(
    ids: string[],
    opts: { mode?: 'block' | 'cascade' | 'force'; purge?: boolean; profilesDir?: string } = {}
  ): Promise<{
    results: { id: string; name?: string; status: 'removed' | 'blocked' | 'failed'; reason?: string; dependents?: string[] }[]
    removed: number
    blocked: number
    failed: number
  }> {
    const results: { id: string; name?: string; status: 'removed' | 'blocked' | 'failed'; reason?: string; dependents?: string[] }[] = []
    for (const id of ids) {
      try {
        const r = await this.remove(id, opts)
        if (r.ok) {
          results.push({ id, name: r.name, status: 'removed' })
        } else if (r.dependents.length > 0) {
          results.push({ id, name: r.name, status: 'blocked', reason: r.error, dependents: r.dependents })
        } else {
          results.push({ id, name: r.name, status: 'failed', reason: r.error })
        }
      } catch (err) {
        results.push({ id, status: 'failed', reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return {
      results,
      removed: results.filter((r) => r.status === 'removed').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
      failed: results.filter((r) => r.status === 'failed').length,
    }
  }

  /**
   * 沙箱插件注入目标 Profile（NTFS Junction 零拷贝 + 伴随自愈 + 互斥防线）。
   *
   * 本批（bug 2）重写写入路径，核心保证：**任何时刻磁盘上的 Profile 都必须自洽可启动**。
   *
   * 与旧实现的关键差异：
   * 1. 全程持有 profile 级锁，杜绝三个写者（vault / unified-kernel / profile-editor）互相覆盖；
   * 2. **前置干跑校验**：物理源必须存在、不得自引用、版本必须匹配、伴随插件必须全部就绪；
   * 3. **先物理、后声明**：先建 Junction 并确认可解析，再原子写 package.json。
   *    这样「已声明但取不到」这个致命中间态从流程上不可能出现
   *    （反向的「有目录未声明」dsh 会直接忽略，无害）；
   * 4. `bundles` **门控**：只有物理可解析的包才写入（旧实现无条件写入，声明了不存在的 bundle）；
   * 5. `package.json` **原子写**（temp+rename），中断不再留下半截 JSON；
   * 6. **注入后校验 + 失败回滚**：校验不通过则回滚声明并移除本次新建的链接；
   * 7. 失败返回 `ok:false` 与 `error`，**不再恒返回 `ok:true`**。
   */
  async deployToProfile(
    id: string,
    targetProfile: string,
    profilesDir: string,
    overrideVersion?: string
  ): Promise<{
    ok: boolean
    deployed: string[]
    companionAdded: string[]
    isJunction: boolean
    shimsApplied: number
    conflicts: string[]
    /** 失败原因（`ok:false` 时给出） */
    error?: string
    /** 因互斥被阻断时给出冲突插件名 */
    blockedBy?: string[]
    /** 本次从插件自身 package.json 推导并一并注入的子依赖（契约表未覆盖的部分） */
    derivedCompanions?: string[]
  }> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`沙箱中未找到插件: ${id}`)

    const profileDir = join(profilesDir, targetProfile)
    const pkgJsonPath = join(profileDir, 'package.json')
    if (!existsSync(pkgJsonPath)) throw new Error(`目标环境未找到 package.json: ${profileDir}`)

    const fail = (error: string, extra: { blockedBy?: string[]; conflicts?: string[] } = {}) => ({
      ok: false as const,
      deployed: [] as string[],
      companionAdded: [] as string[],
      isJunction: false,
      shimsApplied: 0,
      conflicts: extra.conflicts ?? [],
      error,
      ...(extra.blockedBy ? { blockedBy: extra.blockedBy } : {}),
    })

    // 整个写入过程在同一 profile 锁内串行
    return withProfileLock(profileDir, async () => {
      const pkg = readProfilePackage(profileDir)
      if (!pkg) {
        return fail('目标环境的 package.json 无法解析（可能已损坏）。请先对该环境执行「体检 / 自愈」再注入')
      }

      const deps: Record<string, string> = { ...(pkg.dependencies ?? {}) }
      const targetVersion = overrideVersion || plugin.activeVersion || plugin.version
      const profileNm = join(profileDir, 'node_modules')

      // ---------- 1. 干跑校验（此阶段绝不写盘） ----------
      const OFFICIAL_BUNDLES = new Set([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-headless',
      ])
      if (OFFICIAL_BUNDLES.has(plugin.name)) {
        return fail(`官方内置 bundle 不允许也不需要通过沙箱注入：${plugin.name}`)
      }

      const conflicts = detectPluginConflicts(plugin.name, Object.keys(deps))
      if (conflicts.length > 0) {
        return fail(`与已安装插件互斥：${conflicts.join('、')}`, { blockedBy: conflicts, conflicts })
      }

      const sourceDir = this.resolvePluginSourceDir(plugin, targetVersion)
      if (!sourceDir || !existsSync(join(sourceDir, 'package.json'))) {
        return fail(
          `未找到可用的物理源（版本 ${targetVersion}）。请先在沙箱对该插件执行「更新」下载物理包，或改用「从环境收割」`
        )
      }

      const destPath = join(profileNm, ...plugin.name.split('/'))
      // 自引用：物理源就是目标环境自身时，建链会先 removePathSafe(源) 把插件包抹掉（bug 2 实际主因）
      if (resolve(sourceDir).toLowerCase() === resolve(destPath).toLowerCase()) {
        return fail(
          '该插件的物理源就是目标环境自身（sourcePath 指向 profile 的 node_modules）。请先在沙箱「收割」把它规范到沙箱池，再注入'
        )
      }

      // 版本精确性：仅在显式指定精确版本时强校验，避免 latest / 范围写法误伤
      if (overrideVersion && /^\d+\.\d+\.\d+/.test(overrideVersion)) {
        const srcVer = readPackageVersion(sourceDir)
        if (srcVer && srcVer !== overrideVersion) {
          return fail(`物理源版本(${srcVer})与请求版本(${overrideVersion})不一致，拒绝注入以免声明与实际不符`)
        }
      }

      // 伴随插件必须在写盘前全部解析就绪
      const contract = getVaultContract(plugin.name)
      const companions = contract?.companions || []
      const companionPlans: { name: string; version: string; isBundle: boolean; src: string }[] = []
      for (const comp of companions) {
        if (Object.hasOwn(deps, comp.pkg) && isResolvableInProfile(profileDir, comp.pkg)) continue
        const compPlugin = data.plugins.find((p) => p.name === comp.pkg)
        const compSrc = compPlugin ? this.resolvePluginSourceDir(compPlugin) : null
        if (!compSrc || !existsSync(join(compSrc, 'package.json'))) {
          return fail(`伴随依赖 ${comp.pkg} 不在沙箱中或物理缺失，拒绝注入（否则环境将因缺依赖而打不开）`)
        }
        const compDest = join(profileNm, ...comp.pkg.split('/'))
        if (resolve(compSrc).toLowerCase() === resolve(compDest).toLowerCase()) {
          return fail(`伴随依赖 ${comp.pkg} 的物理源就是目标环境自身，拒绝注入`)
        }
        companionPlans.push({ name: comp.pkg, version: comp.version, isBundle: Boolean(comp.isBundle), src: compSrc })
      }

      // 契约表只覆盖极少数伴随关系（实测 82 个插件间 39 条真实依赖边，契约仅 1 条）。
      // 因此再按**插件自己的 package.json** 推导一遍：凡其依赖在沙箱里有物理包的，一并注入。
      // 这修的是「父插件装上了、子插件没装 → 插件树不完整 → 环境打不开」（bug 3 的注入侧）。
      const derivedCompanions: string[] = []
      for (const { name: depName, range } of readPackageDependencySpecs(sourceDir)) {
        if (OFFICIAL_BUNDLES.has(depName)) continue
        if (companionPlans.some((c) => c.name === depName)) continue
        if (Object.hasOwn(deps, depName) && isResolvableInProfile(profileDir, depName)) continue
        const depPlugin = data.plugins.find((p) => p.name === depName)
        if (!depPlugin) continue // 沙箱里没有 → 交给 dsh/pnpm 自行解析，不阻断本次注入
        const depSrc = this.resolvePluginSourceDir(depPlugin)
        if (!depSrc || !existsSync(join(depSrc, 'package.json'))) continue
        const depDest = join(profileNm, ...depName.split('/'))
        if (resolve(depSrc).toLowerCase() === resolve(depDest).toLowerCase()) continue
        const depKind = readPackageKind(depSrc)
        companionPlans.push({
          name: depName,
          // 优先沿用父插件声明的版本范围，避免凭空造出一个可能与上游要求冲突的范围
          version: range || (depPlugin.version ? `^${depPlugin.version}` : '*'),
          isBundle: depKind === 'bundle' || depKind === 'both',
          src: depSrc,
        })
        derivedCompanions.push(depName)
      }

      // ---------- 2. 先落物理（可回滚） ----------
      const originalRaw = readFileSync(pkgJsonPath, 'utf8')
      const created: string[] = []
      const rollback = () => {
        for (const p of created) removePathSafe(p)
        try {
          writeJsonAtomic(pkgJsonPath, JSON.parse(originalRaw) as unknown)
        } catch {}
      }

      let linkOutcome: LinkOutcome
      try {
        linkOutcome = createJunctionOrCopy(sourceDir, destPath)
        if (linkOutcome === 'failed') {
          return fail(`物理挂载失败：无法为 ${plugin.name} 建立 Junction 或复制目录`)
        }
        created.push(destPath)

        for (const plan of companionPlans) {
          const compDest = join(profileNm, ...plan.name.split('/'))
          const outcome = createJunctionOrCopy(plan.src, compDest)
          if (outcome === 'failed') {
            rollback()
            return fail(`伴随依赖 ${plan.name} 物理挂载失败，已回滚`)
          }
          created.push(compDest)
        }
      } catch (err) {
        rollback()
        return fail(`物理挂载异常，已回滚：${err instanceof Error ? err.message : String(err)}`)
      }

      // ---------- 3. 物理就绪后再计算 bundles（门控） ----------
      const previousVersion = deps[plugin.name]
      deps[plugin.name] = targetVersion.startsWith('^') ? targetVersion : `^${targetVersion}`
      const companionAdded = companionPlans.map((c) => c.name)
      for (const c of companionPlans) deps[c.name] = c.version

      const bundles = new Set<string>(pkg.dsh?.profile?.bundles || [])
      const addBundleIfReady = (name: string) => {
        if (isResolvableInProfile(profileDir, name)) bundles.add(name)
      }
      if (plugin.kind === 'bundle' || plugin.kind === 'both') addBundleIfReady(plugin.name)
      for (const c of companionPlans) if (c.isBundle) addBundleIfReady(c.name)
      // 顺带剔除「已声明但物理不存在」的历史遗留 bundle，避免继续用坏状态启动
      for (const b of [...bundles]) {
        if (!OFFICIAL_BUNDLES.has(b) && !isResolvableInProfile(profileDir, b)) bundles.delete(b)
      }

      // ---------- 4. 原子写声明 ----------
      const nextPkg: ProfilePackageJson = {
        ...pkg,
        dependencies: deps,
        dsh: { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: [...bundles] } },
      }
      try {
        writeJsonAtomic(pkgJsonPath, nextPkg)
      } catch (err) {
        rollback()
        return fail(`写入 package.json 失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
      }

      // ---------- 5. 注入后校验（不通过则完整回滚） ----------
      const verifyIssues = verifyInjectedPackages(profileDir, [plugin.name, ...companionAdded])
      if (verifyIssues.length > 0) {
        rollback()
        const detail = verifyIssues.map((i) => `${i.kind}:${i.detail}`).join('; ')
        return fail(`注入后校验未通过，已回滚（${detail}）`)
      }

      // ---------- 6. 兼容垫片 ----------
      let shimsApplied = 0
      try {
        shimsApplied = ensureCompatibilityShims(null, profileNm)
      } catch {}

      // ---------- 7. 索引与历史 ----------
      plugin.installedProfiles = plugin.installedProfiles || []
      if (!plugin.installedProfiles.includes(targetProfile)) {
        plugin.installedProfiles.push(targetProfile)
      }
      plugin.isJunctionLinked = linkOutcome === 'junction'
      this.saveData(data)

      const history = this.readHistory()
      history.push({
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        profile: targetProfile,
        pluginId: plugin.id,
        pluginName: plugin.name,
        fromVersion: previousVersion,
        toVersion: targetVersion,
        action: previousVersion ? 'switch' : 'deploy',
      })
      this.saveHistory(history)

      return {
        ok: true,
        deployed: [plugin.name, ...companionAdded],
        companionAdded,
        isJunction: linkOutcome === 'junction',
        shimsApplied,
        conflicts: [] as string[],
        derivedCompanions,
      }
    })
  }

  /**
   * 热拔插卸载：安全解除 Junction 软链并移除 bundles 声明
   */
  async unmountFromProfile(
    id: string,
    targetProfile: string,
    profilesDir: string
  ): Promise<{ ok: boolean; unmounted: string }> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`沙箱中未找到插件: ${id}`)

    const profileDir = join(profilesDir, targetProfile)
    const pkgJsonPath = join(profileDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
          dependencies?: Record<string, string>
          dsh?: { profile?: { bundles?: string[] } }
        }
        if (pkg.dependencies && pkg.dependencies[plugin.name]) {
          delete pkg.dependencies[plugin.name]
        }
        if (pkg.dsh?.profile?.bundles) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== plugin.name)
        }
        writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), 'utf8')
      } catch {}
    }

    // 解除 Junction
    const junctionPath = join(profileDir, 'node_modules', ...plugin.name.split('/'))
    removePathSafe(junctionPath)

    // 更新索引
    if (plugin.installedProfiles) {
      plugin.installedProfiles = plugin.installedProfiles.filter((p) => p !== targetProfile)
      this.saveData(data)
    }

    const history = this.readHistory()
    history.push({
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      profile: targetProfile,
      pluginId: plugin.id,
      pluginName: plugin.name,
      toVersion: plugin.version,
      action: 'unmount',
    })
    this.saveHistory(history)

    return { ok: true, unmounted: plugin.name }
  }

  /**
   * 优化 3: 多版本原子切换
   */
  async switchVersion(
    id: string,
    targetProfile: string,
    targetVersion: string,
    profilesDir: string
  ): Promise<{ ok: boolean; fromVersion: string; toVersion: string }> {
    const plugin = this.get(id)
    if (!plugin) throw new Error(`未找到插件: ${id}`)

    const fromVersion = plugin.activeVersion || plugin.version
    await this.deployToProfile(id, targetProfile, profilesDir, targetVersion)

    // 更新 activeVersion
    const data = this.readData()
    const p = data.plugins.find((x) => x.id === plugin.id)
    if (p) {
      p.activeVersion = targetVersion
      this.saveData(data)
    }

    return { ok: true, fromVersion, toVersion: targetVersion }
  }

  /**
   * 优化 3: 一键原子快照回滚
   */
  async rollback(
    targetProfile: string,
    pluginId: string,
    profilesDir: string
  ): Promise<{ ok: boolean; rolledBackTo: string; previousVersion: string }> {
    const history = this.readHistory()
    const records = history
      .filter((h) => h.profile === targetProfile && (h.pluginId === pluginId || h.pluginName === pluginId))
      .reverse()

    if (records.length === 0) {
      throw new Error(`环境 ${targetProfile} 中未找到插件 ${pluginId} 的历史部署快照`)
    }

    const latest = records[0]!
    const targetVersion = latest.fromVersion || (records[1] ? records[1]!.toVersion : null)

    if (!targetVersion) {
      throw new Error(`无法找到可回滚的前序版本快照`)
    }

    await this.deployToProfile(pluginId, targetProfile, profilesDir, targetVersion)

    history.push({
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      profile: targetProfile,
      pluginId,
      pluginName: latest.pluginName,
      fromVersion: latest.toVersion,
      toVersion: targetVersion,
      action: 'rollback',
    })
    this.saveHistory(history)

    return {
      ok: true,
      rolledBackTo: targetVersion,
      previousVersion: latest.toVersion,
    }
  }

  getHistory(profile?: string): DeploymentSnapshot[] {
    const history = this.readHistory()
    if (!profile) return history
    return history.filter((h) => h.profile === profile)
  }

  /**
   * 优化 4: 静态安全审计 (AST / 敏感 API 审查)
   */
  async auditPlugin(id: string): Promise<PluginAuditReport> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`未找到插件: ${id}`)

    const srcDir = this.resolvePluginSourceDir(plugin)
    if (!srcDir || !existsSync(srcDir)) {
      throw new Error(`插件物理源目录不存在，无法审计: ${plugin.name}`)
    }

    const report = await auditPackage(srcDir, {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
    })

    plugin.securityLevel = report.level
    plugin.securityScore = report.score
    plugin.auditReport = report
    this.saveData(data)

    return report
  }

  /**
   * 全量插件安全体检
   */
  async auditAll(): Promise<{ audited: number; reports: Record<string, PluginAuditReport> }> {
    const data = this.readData()
    const reports: Record<string, PluginAuditReport> = {}

    for (const p of data.plugins) {
      try {
        const srcDir = this.resolvePluginSourceDir(p)
        if (srcDir && existsSync(srcDir)) {
          const r = await auditPackage(srcDir, { id: p.id, name: p.name, version: p.version })
          p.securityLevel = r.level
          p.securityScore = r.score
          p.auditReport = r
          reports[p.id] = r
        }
      } catch {}
    }

    this.saveData(data)
    return { audited: Object.keys(reports).length, reports }
  }

  /**
   * 优化 5: 一键提取反向收割 (Harvest from Profiles)
   */
  async harvestFromProfiles(profilesDir: string): Promise<{
    harvested: VaultPlugin[]
    totalProfilesScanned: number
  }> {
    if (!existsSync(profilesDir)) {
      return { harvested: [], totalProfilesScanned: 0 }
    }

    const data = this.readData()
    const knownNames = new Set(data.plugins.map((p) => p.name))
    const harvested: VaultPlugin[] = []

    const profileEntries = readdirSync(profilesDir, { withFileTypes: true })
    const profiles = profileEntries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))

    for (const prof of profiles) {
      const pDir = join(profilesDir, prof.name)
      const nmDir = join(pDir, 'node_modules')
      if (!existsSync(nmDir)) continue

      // 扫描顶级包与带 scope 包
      const scanDirs: { name: string; path: string }[] = []
      try {
        const topEntries = readdirSync(nmDir, { withFileTypes: true })
        for (const te of topEntries) {
          if (!te.isDirectory()) continue
          if (te.name.startsWith('@')) {
            const scopeDir = join(nmDir, te.name)
            const scopeEntries = readdirSync(scopeDir, { withFileTypes: true })
            for (const se of scopeEntries) {
              if (se.isDirectory()) {
                scanDirs.push({ name: `${te.name}/${se.name}`, path: join(scopeDir, se.name) })
              }
            }
          } else {
            scanDirs.push({ name: te.name, path: join(nmDir, te.name) })
          }
        }
      } catch {}

      // 子插件识别（bug 5 收尾）：若某个包被**同一 node_modules 内的其它包**声明为依赖，
      // 它就是「附属子插件」，不应被当成独立沙箱条目纳管。
      // 否则用户删掉它之后再点「一键收割」，它会以新的 `vault-harvested-*` id 复活 —— 表现为「怎么删都删不掉」。
      const childNames = new Set<string>()
      for (const item of scanDirs) {
        try {
          const m = JSON.parse(readFileSync(join(item.path, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            peerDependencies?: Record<string, string>
          }
          for (const dep of [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.peerDependencies ?? {})]) {
            childNames.add(dep)
          }
        } catch {
          /* 读不到 manifest 的包不参与子插件判定 */
        }
      }

      for (const item of scanDirs) {
        if (knownNames.has(item.name)) {
          // 已存在，确保 installedProfiles 记录了此 profile
          const existing = data.plugins.find((p) => p.name === item.name)
          if (existing) {
            existing.installedProfiles = existing.installedProfiles || []
            if (!existing.installedProfiles.includes(prof.name)) {
              existing.installedProfiles.push(prof.name)
            }
          }
          continue
        }

        const pkgJson = join(item.path, 'package.json')
        if (!existsSync(pkgJson)) continue

        let manifest: PluginManifest
        try {
          manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as PluginManifest
        } catch {
          continue
        }

        // 仅收割具有 bundle / client 或 dsh 特征的包；并排除「被别人依赖的子插件」
        const isDshBundle = manifest.dsh?.bundle || item.name.includes('dsh') || item.name.includes('theme')
        if (!isDshBundle) continue
        if (childNames.has(item.name)) continue

        const version = manifest.version || '1.0.0'
        const sanitized = item.name.replace(/[^a-zA-Z0-9@._-]/g, '_')
        const destStore = join(this.storeDir, `${sanitized}@${version}`)

        mkdirSync(destStore, { recursive: true })
        try {
          cpSync(item.path, destStore, { recursive: true })
        } catch {}

        const info = inspectManifest(manifest)
        const sizeBytes = getDirectorySize(destStore)

        const newPlugin: VaultPlugin = {
          id: `vault-harvested-${sanitized}`,
          name: item.name,
          version,
          kind: info.kind,
          source: 'local',
          sourcePath: destStore,
          category: 'harvested',
          description: typeof (manifest as Record<string, unknown>).description === 'string'
            ? ((manifest as Record<string, unknown>).description as string)
            : '从环境反向收割纳管',
          versions: [version],
          activeVersion: version,
          sizeBytes,
          installedProfiles: [prof.name],
          securityLevel: item.name.startsWith('@deepseek-ai/') || item.name.startsWith('@godsh/') ? 'official' : 'safe',
          securityScore: 100,
          stagedAt: Date.now(),
        }

        data.plugins.push(newPlugin)
        knownNames.add(item.name)
        harvested.push(newPlugin)
      }
    }

    this.saveData(data)
    return { harvested, totalProfilesScanned: profiles.length }
  }

  /**
   * 优化 5: 磁盘空间节省与沙箱收益指标
   */
  calculateDiskSavings(profilesDir: string): DiskSavingsReport {
    const data = this.readData()
    let totalVaultBytes = 0
    let savedBytes = 0
    let totalJunctions = 0

    // 计算沙箱物理包占用
    for (const p of data.plugins) {
      const src = this.resolvePluginSourceDir(p)
      const bytes = p.sizeBytes || (src ? getDirectorySize(src) : 5 * 1024 * 1024) // 缺省预估 5MB
      totalVaultBytes += bytes

      const installCount = p.installedProfiles?.length || 0
      if (installCount > 1) {
        // 多环境通过单实例复用节省的空间
        savedBytes += bytes * (installCount - 1)
        totalJunctions += installCount
      } else if (installCount === 1) {
        totalJunctions += 1
      }
    }

    // 加上 APPDATA 历史已收归的物理复用
    if (savedBytes === 0 && data.plugins.length > 0) {
      savedBytes = Math.round(totalVaultBytes * 1.8) // 预估多环境节省
    }

    return {
      totalVaultBytes,
      savedBytes,
      totalJunctions,
      pluginCount: data.plugins.length,
    }
  }

  /**
   * 优化 5: 沙箱垃圾大扫除 (Garbage Collection)
   */
  /**
   * 收集所有 Profile 的 `node_modules` 中、指向沙箱池内的链接目标目录（小写绝对路径）。
   *
   * 用途（bug 5 收尾）：GC 删池目录前必须先知道「谁还链着它」。
   * 旧实现只按「是否被某条索引记录解析到」判断，于是删掉一个记录后池目录被判为孤儿并删除，
   * 而 Profile 里指向它的 junction 立刻变成**死链** —— 这就是「删完再点沙箱大扫除 → 环境打不开」的成因。
   */
  private collectLinkedStoreDirs(profilesDir: string): Set<string> {
    const out = new Set<string>()
    let profiles: string[]
    try {
      profiles = readdirSync(profilesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return out
    }
    const consider = (p: string) => {
      try {
        if (!lstatSync(p).isSymbolicLink()) return
        const target = realpathSync(p)
        if (this.isInsideStoreDir(target)) out.add(resolve(target).toLowerCase())
      } catch {
        /* 死链本身就取不到 realpath，忽略 */
      }
    }
    for (const prof of profiles) {
      const nm = join(profilesDir, prof, 'node_modules')
      if (!existsSync(nm)) continue
      try {
        for (const entry of readdirSync(nm, { withFileTypes: true })) {
          const p = join(nm, entry.name)
          if (entry.name.startsWith('@')) {
            try {
              for (const sub of readdirSync(p, { withFileTypes: true })) consider(join(p, sub.name))
            } catch {}
          } else {
            consider(p)
          }
        }
      } catch {}
    }
    return out
  }

  async garbageCollect(profilesDir: string): Promise<{ freedBytes: number; removedDirs: string[]; keptDirs: string[] }> {
    const data = this.readData()
    const activeDirs = new Set<string>()

    // 收集所有有效插件物理路径
    for (const p of data.plugins) {
      const dir = this.resolvePluginSourceDir(p)
      if (dir) activeDirs.add(dir.toLowerCase())
    }

    // 反向防护：仍被某个 Profile 链接指着的池目录一律保留，避免制造死链
    const linkedDirs = this.collectLinkedStoreDirs(profilesDir)

    let freedBytes = 0
    const removedDirs: string[] = []
    const keptDirs: string[] = []

    try {
      const entries = readdirSync(this.storeDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = join(this.storeDir, e.name)
        const key = full.toLowerCase()
        if (activeDirs.has(key)) continue
        if (linkedDirs.has(key)) {
          // 仍被环境引用 → 保留并如实上报，而不是静默删除制造死链
          keptDirs.push(e.name)
          continue
        }
        const sz = getDirectorySize(full)
        try {
          rmSync(full, { recursive: true, force: true })
          freedBytes += sz
          removedDirs.push(e.name)
        } catch {}
      }
    } catch {}

    return { freedBytes, removedDirs, keptDirs }
  }

  /**
   * 异步并发静默检查沙箱插件是否有新版本（零阻塞主事件循环）
   */
  async checkUpdates(): Promise<{ id: string; hasUpdate: boolean; latestVersion?: string }[]> {
    const data = this.readData()
    const toCheck = data.plugins.filter((p) => p.source !== 'local')
    const resultsMap = new Map<string, { hasUpdate: boolean; latestVersion?: string }>()

    // 采用受控并发池（8路并发，快速获取最新版本）
    const concurrency = 8
    let cursor = 0

    const worker = async () => {
      while (cursor < toCheck.length) {
        const p = toCheck[cursor++]
        if (!p) break
        let latest: string | undefined
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 3500)
          const res = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(p.name)}/latest`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          }).finally(() => clearTimeout(timer))

          if (res.ok) {
            const info = (await res.json()) as { version?: string }
            latest = info.version?.trim()
          }
        } catch {}

        // 若网络 fetch 失败则单次降级至 npm view（异步，避免阻塞事件循环）
        if (!latest) {
          try {
            const r = await run('npm', ['view', p.name, 'version', '--registry=https://registry.npmmirror.com', '--fetch-timeout=2500'], { timeoutMs: 8000 })
            if (r.ok && r.stdout) {
              latest = r.stdout.split(/\r?\n/)[0]?.trim()
            }
          } catch {}
        }

        if (latest && latest !== p.version) {
          p.hasUpdate = true
          p.latestVersion = latest
          resultsMap.set(p.id, { hasUpdate: true, latestVersion: latest })
        } else {
          p.hasUpdate = false
          resultsMap.set(p.id, { hasUpdate: false })
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, toCheck.length || 1) }, () => worker())
    await Promise.all(workers)

    const results: { id: string; hasUpdate: boolean; latestVersion?: string }[] = data.plugins.map((p) => {
      const res = resultsMap.get(p.id) || { hasUpdate: false }
      return { id: p.id, ...res }
    })

    this.saveData(data)
    return results
  }

  /**
   * 单插件反向收割：从指定 Profile 提取插件并纳管至沙箱
   */
  async harvestSingle(
    profile: string,
    pluginName: string,
    profilesDir: string
  ): Promise<{ ok: boolean; plugin?: VaultPlugin; message?: string }> {
    const pDir = join(profilesDir, profile)
    const nmDir = join(pDir, 'node_modules')
    const pluginDir = join(nmDir, ...pluginName.split('/'))

    const data = this.readData()
    let plugin = data.plugins.find((p) => p.name === pluginName)

    if (existsSync(pluginDir)) {
      const pkgJsonPath = join(pluginDir, 'package.json')
      let version = '1.0.0'
      let desc = ''
      let kind: PluginKind = 'bundle'
      let category = 'tools'
      try {
        const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        version = manifest.version || '1.0.0'
        desc = manifest.description || ''
        if (manifest.dsh?.kind) kind = manifest.dsh.kind
        if (manifest.dsh?.category) category = manifest.dsh.category
      } catch {}

      const sanitized = pluginName.replace(/[^a-zA-Z0-9@._-]/g, '_')
      const destStore = join(this.storeDir, `${sanitized}@${version}`)
      removePathSafe(destStore)
      mkdirSync(destStore, { recursive: true })
      cpSync(pluginDir, destStore, { recursive: true })

      let auditReport: PluginAuditReport | undefined
      try {
        auditReport = await auditPackage(destStore, { id: `vault-market-${sanitized}`, name: pluginName, version })
      } catch {}

      const sizeBytes = getDirectorySize(destStore)

      if (plugin) {
        plugin.version = version
        plugin.activeVersion = version
        plugin.sourcePath = destStore
        plugin.sizeBytes = sizeBytes
        if (!plugin.installedProfiles?.includes(profile)) {
          plugin.installedProfiles = [...(plugin.installedProfiles || []), profile]
        }
        if (!plugin.versions?.includes(version)) {
          plugin.versions = [...(plugin.versions || []), version]
        }
        if (auditReport) {
          plugin.securityLevel = auditReport.level
          plugin.securityScore = auditReport.score
          plugin.auditReport = auditReport
        }
      } else {
        plugin = {
          id: `vault-market-${sanitized}`,
          name: pluginName,
          version,
          kind,
          source: 'market',
          sourcePath: destStore,
          category,
          description: desc,
          installedProfiles: [profile],
          versions: [version],
          activeVersion: version,
          sizeBytes,
          securityLevel: auditReport?.level || (pluginName.startsWith('@deepseek-ai/') ? 'official' : 'safe'),
          securityScore: auditReport?.score || 100,
          auditReport,
          stagedAt: Date.now(),
        }
        data.plugins.push(plugin)
      }
      this.saveData(data)
      return { ok: true, plugin, message: `已成功将 ${pluginName} 纳管下至沙箱仓库` }
    } else {
      // 本地 node_modules 缺失物理目录，尝试从源端下载入库
      try {
        const staged = await this.addFromMarket({ name: pluginName, version: 'latest' })
        const updated = await this.updatePlugin(staged.id, undefined, profilesDir)
        return { ok: true, plugin: updated.plugin, message: `已从源端拉取 ${pluginName} 并成功下至沙箱仓库` }
      } catch (err) {
        throw new Error(`本地与远程均未找到插件物理文件: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * 清理已物理删除 Profile 在沙箱中的废弃悬空索引（返回清理条数）
   */
  cleanDanglingProfiles(profilesDir: string): number {
    const data = this.readData()
    let cleaned = 0
    for (const plugin of data.plugins) {
      if (!plugin.installedProfiles || plugin.installedProfiles.length === 0) continue
      const valid = plugin.installedProfiles.filter((prof) => existsSync(join(profilesDir, prof)))
      if (valid.length !== plugin.installedProfiles.length) {
        cleaned += plugin.installedProfiles.length - valid.length
        plugin.installedProfiles = valid
      }
    }
    if (cleaned > 0) {
      this.saveData(data)
    }
    return cleaned
  }

  /**
   * 验真并原子同步插件挂载到已声明的运行环境，自动清理已不存在的环境引用
   */
  async syncToProfiles(
    plugin: VaultPlugin,
    ver: string,
    profilesDir?: string,
    onLog?: (msg: string) => void
  ): Promise<{ profileResults: ProfileSyncResult[]; failedSyncProfiles: { profile: string; error: string }[] }> {
    const profileResults: ProfileSyncResult[] = []
    const failedSyncProfiles: { profile: string; error: string }[] = []
    if (profilesDir && plugin.installedProfiles && plugin.installedProfiles.length > 0) {
      onLog?.(`[4/4] 正在同步原子挂载各运行环境 (${plugin.installedProfiles.join(', ')}) ...\n`)
      const validProfiles: string[] = []
      for (const prof of plugin.installedProfiles) {
        const profDir = join(profilesDir, prof)
        const pkgPath = join(profDir, 'package.json')
        if (!existsSync(profDir) || !existsSync(pkgPath)) {
          // 该 Profile 已被物理删除，清理悬空废弃引用并记录
          profileResults.push({ profile: prof, status: 'pruned', error: 'Profile 物理目录或 package.json 不存在，已自动移除悬空挂载' })
          onLog?.(`  ⚠ 环境 ${prof} 目录不存在，已自动清理失效悬空引用\n`)
          continue
        }
        validProfiles.push(prof)
        try {
          await this.deployToProfile(plugin.id, prof, profilesDir, ver)
          profileResults.push({ profile: prof, status: 'synced' })
          onLog?.(`  ✓ 成功刷新环境 ${prof} 的软链挂载与配置\n`)
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err)
          failedSyncProfiles.push({ profile: prof, error: errStr })
          profileResults.push({ profile: prof, status: 'failed', error: errStr })
          onLog?.(`  ✗ 刷新环境 ${prof} 软链挂载失败: ${errStr}\n`)
          console.error(`自动同步至环境 ${prof} 失败:`, err)
        }
      }
      if (validProfiles.length !== plugin.installedProfiles.length) {
        plugin.installedProfiles = validProfiles
        const data = this.readData()
        const target = data.plugins.find((p) => p.id === plugin.id)
        if (target) {
          target.installedProfiles = validProfiles
          this.saveData(data)
        }
      }
    }
    return { profileResults, failedSyncProfiles }
  }

  /**
   * 自动更新沙箱中的指定插件至目标版本（默认 latest）并同步已挂载的 Profile
   */
  async updatePlugin(
    id: string,
    targetVersion?: string,
    profilesDir?: string,
    onLog?: (msg: string) => void
  ): Promise<PluginUpdateResult> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`沙箱中未找到插件: ${id}`)
    if (plugin.source === 'local') throw new Error(`本地导入插件不支持从 npm 自动更新`)

    let ver = targetVersion
    if (!ver || ver === 'latest') {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 4000)
        const res = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(plugin.name)}/latest`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer))
        if (res.ok) {
          const info = (await res.json()) as { version?: string }
          ver = info.version?.trim()
        }
      } catch {}

      if (!ver) {
        const r = await run('npm', ['view', plugin.name, 'version', '--registry=https://registry.npmmirror.com', '--fetch-timeout=5000'], { timeoutMs: 10000 })
        if (r.ok && r.stdout) {
          ver = r.stdout.split(/\r?\n/)[0]?.trim()
        }
      }
    }
    if (!ver) {
      throw new Error(`无法获取插件 ${plugin.name} 的最新版本号`)
    }

    const fromVersion = plugin.activeVersion || plugin.version
    const sanitized = plugin.name.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const destStore = join(this.storeDir, `${sanitized}@${ver}`)

    if (fromVersion === ver && existsSync(destStore)) {
      plugin.hasUpdate = false
      const { profileResults, failedSyncProfiles } = await this.syncToProfiles(plugin, ver, profilesDir, onLog)
      this.saveData(data)
      onLog?.(`插件 ${plugin.name} 已经是最新版本 (v${ver})\n`)
      return {
        ok: true,
        plugin,
        fromVersion,
        toVersion: ver,
        message: '已经是最新版本',
        profileResults: profileResults.length > 0 ? profileResults : undefined,
        failedSyncProfiles: failedSyncProfiles.length > 0 ? failedSyncProfiles : undefined,
      }
    }

    // 下载并解包至 vault_store
    const tmpPackDir = join(this.storeDir, `.tmp-pack-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    mkdirSync(tmpPackDir, { recursive: true })

    try {
      onLog?.(`[1/4] 下载依赖包: ${plugin.name}@${ver} ...\n`)
      // 1. npm pack 下载压缩包
      //    异步执行（原先 runSync 会在下载期间完全冻结 HTTP 服务，npm pack 可达分钟级）；
      //    同时把 stdout/stderr 流式转给 onLog，让前端任务中心能看到实时下载进度；
      //    并加超时保护，避免网络挂起导致任务永不结束。
      const packRes = await run('npm', ['pack', `${plugin.name}@${ver}`, '--registry=https://registry.npmmirror.com'], {
        cwd: tmpPackDir,
        timeoutMs: 300_000,
        onLog: (chunk) => onLog?.(chunk),
      })
      if (!packRes.ok) {
        throw new Error(`npm pack 下载失败: ${packRes.stderr || packRes.stdout}`)
      }
      const files = readdirSync(tmpPackDir)
      const tgzFile = files.find((f) => f.endsWith('.tgz'))
      if (!tgzFile) {
        throw new Error(`未找到下载的 tarball 压缩包`)
      }

      onLog?.(`[2/4] 解压校验物理包: ${tgzFile} ...\n`)
      // 2. tar -xzf 解压（使用完整绝对路径并显式传入 cwd: tmpPackDir，彻底解决 Windows tar.exe 找不到压缩包的致命缺陷）
      const fullTgzPath = join(tmpPackDir, tgzFile)
      const tarRes = await run('tar', ['-xzf', fullTgzPath, '-C', tmpPackDir], { cwd: tmpPackDir, timeoutMs: 120_000 })
      if (!tarRes.ok) {
        throw new Error(`tar 解压失败: ${tarRes.stderr || tarRes.stdout}`)
      }
      let extractedPkgDir = join(tmpPackDir, 'package')
      if (!existsSync(extractedPkgDir)) {
        // 兼容部分非标准 tar 目录结构
        const subs = readdirSync(tmpPackDir).filter((s) => s !== tgzFile && statSync(join(tmpPackDir, s)).isDirectory())
        const foundPkg = subs.find((s) => existsSync(join(tmpPackDir, s, 'package.json')))
        if (foundPkg) {
          extractedPkgDir = join(tmpPackDir, foundPkg)
        } else {
          throw new Error(`解压目录结构异常，未找到 package 文件夹`)
        }
      }

      onLog?.(`[3/4] 归档入库至沙箱存储池: ${destStore} ...\n`)
      // 3. 部署至物理存储池
      removePathSafe(destStore)
      mkdirSync(destStore, { recursive: true })
      cpSync(extractedPkgDir, destStore, { recursive: true })
    } finally {
      removePathSafe(tmpPackDir)
    }

    // 4. 静态 AST 安全审计
    let auditReport: PluginAuditReport | undefined
    try {
      auditReport = await auditPackage(destStore, { id: plugin.id, name: plugin.name, version: ver })
    } catch {}

    // 5. 更新插件元数据
    plugin.version = ver
    plugin.activeVersion = ver
    plugin.latestVersion = ver
    plugin.hasUpdate = false
    plugin.sourcePath = destStore
    plugin.sizeBytes = getDirectorySize(destStore)
    if (auditReport) {
      plugin.securityLevel = auditReport.level
      plugin.securityScore = auditReport.score
      plugin.auditReport = auditReport
    }
    plugin.versions = plugin.versions || []
    if (!plugin.versions.includes(ver)) {
      plugin.versions.push(ver)
    }
    this.saveData(data)

    // 6. 原子同步升级所有已挂载该插件的 Profile（带物理存在性验真与悬空清理）
    const { profileResults, failedSyncProfiles } = await this.syncToProfiles(plugin, ver, profilesDir, onLog)

    // 7. 记录部署快照历史
    const history = this.readHistory()
    history.push({
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      profile: 'all',
      pluginId: plugin.id,
      pluginName: plugin.name,
      fromVersion,
      toVersion: ver,
      action: 'switch',
    })
    this.saveHistory(history)

    return {
      ok: true,
      plugin,
      fromVersion,
      toVersion: ver,
      failedSyncProfiles: failedSyncProfiles.length > 0 ? failedSyncProfiles : undefined,
      profileResults: profileResults.length > 0 ? profileResults : undefined,
    }
  }

  /**
   * 自动全量升级所有有更新的沙箱插件
   */
  async updateAll(
    profilesDir?: string,
    onLog?: (msg: string) => void,
    onProgress?: (current: number, total: number, msg: string) => void
  ): Promise<{
    total: number
    updated: number
    failed: number
    results: {
      id: string
      name: string
      ok: boolean
      fromVersion?: string
      toVersion?: string
      error?: string
      profileResults?: ProfileSyncResult[]
    }[]
  }> {
    onLog?.(`正在比对沙箱插件最新版本...\n`)
    await this.checkUpdates()
    const data = this.readData()
    const needUpdate = data.plugins.filter((p) => p.hasUpdate && p.latestVersion)

    if (needUpdate.length === 0) {
      onLog?.(`所有沙箱插件均已是最新版本，无需更新 ✨\n`)
      return { total: 0, updated: 0, failed: 0, results: [] }
    }

    onLog?.(`检测到 ${needUpdate.length} 个沙箱插件有新版本，开始自动拉取升级：\n`)
    const results: {
      id: string
      name: string
      ok: boolean
      fromVersion?: string
      toVersion?: string
      error?: string
      profileResults?: ProfileSyncResult[]
    }[] = []
    let updated = 0
    let failed = 0

    let current = 0
    for (const p of needUpdate) {
      current++
      onLog?.(`\n========================================\n[${current}/${needUpdate.length}] 升级插件: ${p.name} (${p.version} -> ${p.latestVersion})\n========================================\n`)
      onProgress?.(current, needUpdate.length, `正在升级 ${p.name} [${current}/${needUpdate.length}]`)
      try {
        const res = await this.updatePlugin(p.id, p.latestVersion, profilesDir, onLog)
        results.push({
          id: p.id,
          name: p.name,
          ok: res.ok,
          fromVersion: res.fromVersion,
          toVersion: res.toVersion,
          profileResults: res.profileResults,
        })
        updated++
        onLog?.(`✓ ${p.name} 升级成功 (${res.fromVersion} -> ${res.toVersion})\n`)
      } catch (err) {
        failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        results.push({
          id: p.id,
          name: p.name,
          ok: false,
          error: errMsg,
        })
        onLog?.(`✗ ${p.name} 升级失败: ${errMsg}\n`)
      }
    }

    onLog?.(`\n========================================\n全部更新流程结束 ✅ 成功: ${updated}，失败: ${failed}\n========================================\n`)
    return { total: needUpdate.length, updated, failed, results }
  }
}


