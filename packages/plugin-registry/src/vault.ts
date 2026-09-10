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
  /**
   * 子插件归属：存在即表示本条记录是**某个父插件的附属子依赖**，值为父插件的 id。
   *
   * 为什么不复用上面的 `kind`：`kind` 表达的是「bundle / client」这类**插件类别**，
   * 与「这条记录归谁所有」是两个正交维度。把归属塞进 `kind` 会让 UI 与契约判定
   * 把子依赖误当成根插件（这正是子依赖淹没列表的老问题）。
   */
  parentId?: string
  /**
   * 子副本来源：
   * - `standalone`：沙箱里那份**唯一**副本直接归到这个父名下（不复制物理目录）；
   * - `shared-copy`：被两个及以上父共同占有，为这个父**单独复制**的物理副本。
   *
   * 为什么要区分而不是只留 `parentId`：standalone 的物理目录是池里共享的那一份，
   * shared-copy 则必须按父隔离。删除父插件时只有知道这一点，才能既回收自己的副本、
   * 又绝不碰另一个父的副本（两者物理路径完全不同）。
   */
  childOrigin?: 'standalone' | 'shared-copy'
  /** 仅根插件使用：本插件名下已捆绑的子依赖名（供 UI 折叠展示与「父是否还在」判定） */
  bundledDeps?: string[]
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

/** 把包名规范成可安全用作目录名的形式（保留 scope 的 `@` 与 `/`→`_` 等既有约定）。 */
function sanitizePackageName(name: string): string {
  return name.replace(/[^a-zA-Z0-9@._-]/g, '_')
}

/**
 * 子插件副本在沙箱池里的**按父隔离**目录名。
 *
 * 第一层（父是根插件）沿用既有命名 `<父名>__<依赖>@<版本>`，这是已发布的结构，不能改。
 * 更深层（孙辈及以下）用**父条目的 id** 作前缀：`<父id>__<依赖>@<版本>`。
 * 为什么深层必须换成 id：同名依赖允许出现在不同组合里（根 `X` 的子 vs 别人的子 `X` 的孙辈），
 * 只用名字拼前缀会撞名、两个组合共用一份物理目录，按父隔离当场失效；而条目 id 天然唯一。
 */
function childStoreDirName(owner: VaultPlugin, childName: string, version: string): string {
  const prefix = owner.parentId ? sanitizePackageName(owner.id) : sanitizePackageName(owner.name)
  return `${prefix}__${sanitizePackageName(childName)}@${version}`
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
 * profile 里某个包**当前实际指向**的目录（小写绝对路径）；不是链接或链接已断则返回 null。
 *
 * 为什么不能只看「能不能解析到 package.json」：那个判定既区分不出「链到本父的副本」还是
 * 「链到另一个父的副本」（I1 的成因），也给不出真实目标；而 realpath 是唯一无歧义的口径，
 * 取不到目标（断链 / 权限 / 被杀软锁住）即视为「没有有效目标」，由调用方决定是否重指。
 */
function profileLinkTarget(profileDir: string, name: string): string | null {
  const p = join(profileDir, 'node_modules', ...name.split('/'))
  try {
    if (!lstatSync(p).isSymbolicLink()) return null
    return resolve(realpathSync(p)).toLowerCase()
  } catch {
    // 路径不存在或链接已断（realpath 取不到目标）→ 视为「没有有效目标」，由调用方决定是否重指
    return null
  }
}

/** profile 里某个包是否**正好**指向给定物理目录（用于判断「本父那份副本是否已经就位」）。 */
function isProfileLinkedTo(profileDir: string, name: string, sourceDir: string): boolean {
  const target = profileLinkTarget(profileDir, name)
  return target !== null && target === resolve(sourceDir).toLowerCase()
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

  /**
   * 按 id 或**根插件名**定位条目（精确 id 优先）。
   *
   * 为什么按名解析必须排除子副本：子副本与父插件共用同一个包名（`id` 才是
   * `<父id>::<依赖名>`），而 `find` 只会返回第一条，于是「按名找插件」很容易命中
   * 某一个父名下的子副本，随后任何写操作（改版本、改 sourcePath、删目录）都会打在
   * 别人父的那份副本上，直接破坏按父隔离。子副本要用它自己的 id 定位。
   */
  private findByRef(data: VaultDataFile, ref: string): VaultPlugin | undefined {
    return data.plugins.find((p) => p.id === ref) ?? data.plugins.find((p) => !p.parentId && p.name === ref)
  }

  get(id: string): VaultPlugin | undefined {
    return this.findByRef(this.readData(), id)
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
    // 复用只发生在**根条目**上：若按名命中某个父名下的子副本，就会把它的 version 改成新版本
    // 而 sourcePath 仍指向旧的按父隔离目录（版本与物理包不符），甚至把它重新指回公共池名，
    // 两种结果都会破坏按父隔离。同名子副本一律不动，另建独立条目。
    const existing = data.plugins.find((p) => p.id === id) ?? data.plugins.find((p) => !p.parentId && p.name === item.name)

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
   * 建立「根插件 id → 它声明的依赖名集合」索引。
   *
   * 为什么要有这个索引：判定「谁共同占有某个子依赖」需要对每个待归并的依赖遍历全部根插件。
   * 若每次都去读 package.json，就是「依赖数 × 根插件数」次读盘（实测沙箱上百条记录、
   * 父插件动辄几十个依赖，注入路径上足以明显卡顿），因此每个根插件只读一次。
   * 子副本（`parentId` 非空）不进索引：它本身就是被占有的那一份，不是占有者。
   */
  private buildRootDependencyIndex(data: VaultDataFile): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>()
    for (const p of data.plugins) {
      if (p.parentId) continue
      const src = this.resolvePluginSourceDir(p)
      index.set(p.id, new Set(src ? readPackageDependencySpecs(src).map((d) => d.name) : []))
    }
    return index
  }

  /** 把子依赖名记到父插件的 `bundledDeps` 上（幂等）。 */
  private appendBundledDep(parent: VaultPlugin, depName: string): void {
    const list = parent.bundledDeps ?? []
    if (!list.includes(depName)) list.push(depName)
    parent.bundledDeps = list
  }

  /**
   * 为 `owner` 复制一份 `depName` 的物理副本，并在数据快照里登记对应的子插件条目。
   *
   * @returns `false` 表示沙箱里并没有**物理可复制**的那份包（等同于「沙箱里不存在」）；
   *          复制过程本身出错则**抛出**，绝不静默返回 false——静默失败会留下
   *          「父插件以为子依赖已就绪、磁盘上其实什么都没有」的状态，
   *          环境随后必因缺依赖打不开，这正是本项目踩过的坑。
   */
  private copyChildForParent(
    data: VaultDataFile,
    owner: VaultPlugin,
    depName: string,
    candidates: VaultPlugin[]
  ): boolean {
    let srcDir: string | null = null
    let srcEntry: VaultPlugin | undefined
    for (const c of candidates) {
      const dir = this.resolvePluginSourceDir(c)
      if (dir && existsSync(join(dir, 'package.json'))) {
        srcDir = dir
        srcEntry = c
        break
      }
    }
    if (!srcDir || !srcEntry) return false

    // 版本取自物理包本身，保证目录名里的版本与包内声明一致（条目上的 version 可能是脏的）
    const version = readPackageVersion(srcDir) ?? srcEntry.version
    const destDir = join(this.storeDir, childStoreDirName(owner, depName, version))

    // 幂等：副本已存在就直接复用。重复注入是常态（每次 deploy 都会走一遍归并），
    // 若无条件重拷，每注入一次就多搬几 MB，还会打断正在使用该目录的 junction。
    if (!existsSync(join(destDir, 'package.json'))) {
      removePathSafe(destDir)
      mkdirSync(destDir, { recursive: true })
      try {
        cpSync(srcDir, destDir, { recursive: true })
      } catch (err) {
        // 半截副本比没有副本更危险（package.json 可能缺失但目录存在，会被误判为可用）
        removePathSafe(destDir)
        throw new Error(
          `为 ${owner.name} 复制子依赖副本 ${depName} 失败：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const child: VaultPlugin = {
      // id 里带上父 id：同名依赖会被复制给多个父，只有加父维度才能保证记录唯一
      id: `${owner.id}::${depName}`,
      name: depName,
      version,
      kind: readPackageKind(destDir),
      source: srcEntry.source,
      sourcePath: destDir,
      category: srcEntry.category,
      description: srcEntry.description,
      versions: [version],
      activeVersion: version,
      sizeBytes: getDirectorySize(destDir),
      securityLevel: srcEntry.securityLevel,
      securityScore: srcEntry.securityScore,
      auditReport: srcEntry.auditReport,
      // 子副本是随父捆绑进环境的，不是「自己独立装在哪些环境里」：克隆源条目的挂载记录
      // 会让 updatePlugin→syncToProfiles 把它当独立插件去逐环境同步，也会污染
      // calculateDiskSavings 的节省估算。因此一律从空记录起步。
      installedProfiles: [],
      stagedAt: Date.now(),
      parentId: owner.id,
      childOrigin: 'shared-copy',
    }
    data.plugins.push(child)
    return true
  }

  /**
   * 在**已读出的数据快照**上完成「子依赖归并 / 按父复制」，并**递归展开整棵子树**。
   *
   * 为什么把纯结构变换与读盘/落盘拆开：`deployToProfile` 全程持有一份自己的 `data` 快照，
   * 若在这里重新 `readData` 再 `saveData`，两份内存快照会互相覆盖（本项目正是这样丢过数据）。
   * 因此私有实现只改传入的快照，公开方法 `bundleChildrenForParent` 负责读盘与落盘。
   *
   * 为什么必须递归（语义 6）：组合 =「根 + 它的整棵子依赖子树」。若只做一层，子副本自己的
   * 依赖就会以独立根条目形态存在，删除组合时它们会留下来变成孤儿（或反过来被 GC 单独回收），
   * 于是「删母即删子」只删到第一层。这里把每个新建/归并出来的子副本继续当作父展开，
   * 孙辈的 `parentId` 指向那个子副本，因此仍然属于同一个组合，而不是新组合。
   *
   * @returns 本次新建/归并的子插件名（跨层级去重；此前已归到该父名下的不计入）
   */
  private bundleChildrenInData(data: VaultDataFile, parentId: string, childNames: string[]): string[] {
    const anchor = data.plugins.find((p) => p.id === parentId)
    if (!anchor) return []

    const done = new Set<string>()
    // 依赖索引懒建：只有确实有依赖要归并时才去读全部根插件的 manifest
    let depIndex: Map<string, Set<string>> | null = null
    const declaringRoots = (depName: string): VaultPlugin[] => {
      if (!depIndex) depIndex = this.buildRootDependencyIndex(data)
      const index = depIndex
      return data.plugins.filter((p) => !p.parentId && index.get(p.id)?.has(depName) === true)
    }

    // 读某个条目的清单时做一次缓存：递归展开时同一个条目只会被读一次
    const depsCache = new Map<string, { name: string; range: string }[]>()
    const declaredSpecsOf = (entry: VaultPlugin): { name: string; range: string }[] => {
      const cached = depsCache.get(entry.id)
      if (cached) return cached
      const src = entry.parentId ? this.resolveCombinationMemberDir(entry) : this.resolvePluginSourceDir(entry)
      const specs = src ? readPackageDependencySpecs(src) : []
      depsCache.set(entry.id, specs)
      return specs
    }

    // 待展开的父：起始是调用方给的条目，之后是每个新建/归并出来的子副本（孙辈挂到子副本名下）
    const queue: { parent: VaultPlugin; depNames: string[] }[] = [{ parent: anchor, depNames: childNames }]
    // 同一个 (父, 依赖) 只处理一次：同名依赖可能同时出现在多个父的清单里，各自都要有自己的副本
    const processed = new Set<string>()
    const expanded = new Set<string>()

    /**
     * 清理账上的陈旧记录：某个名字既不在该条目**当前清单**里、又没有对应子副本条目，
     * 说明它早已不属于这个组合（典型场景：根插件升级后不再声明该依赖）。
     * 不清掉的话，「账实相符」检查会把这个名字当成永久缺失，用户每次注入都被拒且无从修复。
     * 注意：**仍在清单里**的名字绝不清理 —— 那才是真正的「子副本缺失」，必须继续拦住注入。
     */
    const pruneStaleLedger = (entry: VaultPlugin): void => {
      const ledger = entry.bundledDeps
      if (!ledger || ledger.length === 0) return
      const declared = new Set(declaredSpecsOf(entry).map((s) => s.name))
      const kept = ledger.filter(
        (n) => declared.has(n) || data.plugins.some((c) => c.parentId === entry.id && c.name === n)
      )
      if (kept.length !== ledger.length) entry.bundledDeps = kept
    }
    pruneStaleLedger(anchor)

    while (queue.length > 0) {
      const task = queue.shift()
      if (!task) break
      const parent = task.parent
      if (expanded.has(parent.id)) continue
      expanded.add(parent.id)

      for (const depName of task.depNames) {
        // 自己依赖自己（脏 manifest）会让「父」与「子」指向同一条记录，直接跳过
        if (!depName || depName === parent.name) continue
        const pairKey = `${parent.id}::${depName}`
        if (processed.has(pairKey)) continue
        processed.add(pairKey)

        const candidates = data.plugins.filter((p) => p.name === depName)
        if (candidates.length === 0) continue // 沙箱里确实没有这个包 → 交给 dsh/pnpm 自行解析

        // 谁占有这个依赖：所有**根插件**中 package.json 声明了它的人，外加本次请求的父。
        // 之所以显式算上本次的父：调用方可以传入 manifest 里没写、业务上却确实需要的依赖名，
        // 此时它同样是合法占有者，不能因为「读不到声明」就被判成零占有（那会误判成独占）。
        const owners = declaringRoots(depName)
        if (!owners.some((o) => o.id === parent.id)) owners.push(parent)
        // 稳定排序：同一份沙箱在任何机器上都得到相同的归并结果，便于排查与测试
        owners.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

        const rootEntry = data.plugins.find((p) => p.name === depName && !p.parentId)
        const shared = owners.length >= 2

        /** 收尾：把新产生/归并出来的子条目自己的依赖排进队列，继续展开子树。 */
        const enqueueSubtree = (childEntries: VaultPlugin[]): void => {
          for (const child of childEntries) {
            if (expanded.has(child.id)) continue
            pruneStaleLedger(child)
            const specs = declaredSpecsOf(child)
            if (specs.length === 0) continue
            queue.push({ parent: child, depNames: specs.map((s) => s.name) })
          }
        }

        if (!shared && rootEntry) {
          // 只被这一个父引用：把沙箱里那份条目标记为它的子插件即可，**不复制物理目录**。
          // 这份包本来就没有第二个使用者，复制只是白白多占一份磁盘。
          rootEntry.parentId = parent.id
          rootEntry.childOrigin = 'standalone'
          // 顺手把物理源显式记下来：旧条目（市场暂存）的 sourcePath 常为空，只靠池目录名模糊匹配
          // 才找得到；既然归属已明确，就应该能直接定位到它的物理目录，避免后续再猜。
          if (!rootEntry.sourcePath) {
            const resolvedRoot = this.resolvePluginSourceDir(rootEntry)
            if (resolvedRoot) rootEntry.sourcePath = resolvedRoot
          }
          this.appendBundledDep(parent, depName)
          done.add(depName)
          enqueueSubtree([rootEntry])
          continue
        }

        // 共同占有（或唯一父、但池里那份已被别的父归走）：必须为每个父各复制一份物理副本
        let created = false
        const createdChildren: VaultPlugin[] = []
        for (const owner of owners) {
          if (data.plugins.some((p) => p.parentId === owner.id && p.name === depName)) continue // 已捆绑过
          if (this.copyChildForParent(data, owner, depName, candidates)) {
            this.appendBundledDep(owner, depName)
            created = true
            const child = data.plugins.find((p) => p.id === `${owner.id}::${depName}`)
            if (child) createdChildren.push(child)
          }
        }

        // 共同占有之后，池里那份「公共根条目」已被按父隔离的副本取代，必须从索引里摘掉：
        // 否则它会以独立插件身份继续占着列表与 UI 名额，正是本次要修的「列表被淹没」现象。
        // 前提是**确实复制出了副本**：若物理源缺失导致一份都没复制出来，摘掉根条目等于把这份
        // 依赖从沙箱里抹掉（后面注入时它会既不是子副本、也不是根条目，凭空消失）。
        if (shared && rootEntry && created) {
          data.plugins = data.plugins.filter((p) => p !== rootEntry)
        }
        if (created) done.add(depName)
        enqueueSubtree(createdChildren)
      }
    }
    return [...done]
  }

  /**
   * **组合** = 根条目 + 它名下的**整棵**子副本子树（子、孙、曾孙……）。
   *
   * 为什么要把「组合」集中成一个入口：删除（删母即删子 / 删子即删母）、GC 回收、
   * 注入不变量校验都必须是同一个单位。若各处各写一套 parentId 遍历，迟早漂移。
   *
   * 传入任意成员（根、子、孙）都返回同一个组合；根已不存在的孤儿条目则以其自身为根。
   */
  bundleOf(ref: string | VaultPlugin): VaultPlugin[] {
    const data = this.readData()
    const anchor =
      typeof ref === 'string'
        ? this.findByRef(data, ref)
        : (data.plugins.find((p) => p.id === ref.id) ?? ref)
    if (!anchor) return []
    return this.bundleMembersInData(data, anchor)
  }

  /** `bundleOf` 的快照版本：只读传入的 data，不再读盘（供 remove/GC/deploy 内部使用）。 */
  private bundleMembersInData(data: VaultDataFile, anchor: VaultPlugin): VaultPlugin[] {
    // 上溯到根：从任何成员出发都要落到同一个组合标识（根插件）上。
    // 根已不存在（孤儿）或数据里有环时，以当前条目为根，避免死循环。
    let root = anchor
    const upSeen = new Set<string>([anchor.id])
    while (root.parentId) {
      const parent = data.plugins.find((p) => p.id === root.parentId)
      if (!parent || upSeen.has(parent.id)) break
      upSeen.add(parent.id)
      root = parent
    }

    const members: VaultPlugin[] = [root]
    const visited = new Set<string>([root.id])
    const queue: string[] = [root.id]
    while (queue.length > 0) {
      const parentId = queue.shift()
      if (!parentId) break
      for (const p of data.plugins) {
        if (p.parentId !== parentId || visited.has(p.id)) continue
        visited.add(p.id)
        members.push(p)
        queue.push(p.id)
      }
    }
    return members
  }

  /**
   * 组合成员的物理源目录。
   *
   * 子副本只认自己那份**按父隔离**的 `sourcePath`，不做池里的模糊回退：
   * 回退可能命中同名公共目录（`<name>@<ver>`）或别的父的目录，等于把「本父的副本」
   * 悄悄换成别人的东西（删一个父就会毁掉另一个父）。没有 sourcePath 或目录不可读即视为
   * 「物理源缺失」，由调用方决定拒绝注入 / 回收。
   */
  private resolveCombinationMemberDir(member: VaultPlugin): string | null {
    if (!member.parentId) return this.resolvePluginSourceDir(member)
    const p = member.sourcePath
    if (p && existsSync(join(p, 'package.json'))) return p
    return null
  }


  /**
   * 把 `childNames` 归并/复制为 `parentId` 名下的子插件（第三条规则的公开入口）。
   *
   * 规则（与 `bundleChildrenInData` 一致）：
   * - 只被这一个父引用 → 沙箱里那份直接标记为该父的子插件（`childOrigin: 'standalone'`，不复制）；
   * - 被两个及以上父共同占有 → 为每个父各复制一份到 `vault_store`，目录名按父隔离，
   *   条目 `id = <父id>::<依赖名>`、`childOrigin: 'shared-copy'`。
   *
   * 方法幂等：重复调用不会重复复制，也不会重复上报已捆绑过的子插件。
   *
   * @returns 本次新建/归并的子插件名列表（按入参顺序去重）
   */
  async bundleChildrenForParent(parentId: string, childNames: string[]): Promise<string[]> {
    const data = this.readData()
    const parent = data.plugins.find((p) => p.id === parentId)
    if (!parent) throw new Error(`沙箱中未找到父插件: ${parentId}`)

    const bundled = this.bundleChildrenInData(data, parent.id, childNames)
    if (bundled.length > 0) this.saveData(data)
    return bundled
  }

  /**
   * 一次性迁移：把**升级前遗留的共享子依赖条目**（仍是根条目、却被多个父插件声明为依赖）
   * 归并成「独占 standalone / 共同占有按父复制」的新结构。
   *
   * 为什么需要它：老版本的沙箱里，子依赖被逐条当成独立插件收进来，`vault.json` 中
   * 它们是 `parentId` 为空的根条目。升级后若不迁移，删除父插件时这些条目不会被连带回收，
   * 用户看到的仍是「删不干净」；而迁移是一次性的结构重排，必须在升级时主动跑一遍。
   *
   * 幂等且安全：当前沙箱为空时是纯空操作；已是新结构的条目不会被再次处理。
   *
   * @returns `scanned` 本次扫描的根条目数；`bundled` 被归并/复制的子依赖名（去重）
   */
  async migrateSharedChildren(): Promise<{ scanned: number; bundled: string[] }> {
    const data = this.readData()
    const roots = data.plugins.filter((p) => !p.parentId)

    // 先为每个根插件读一次依赖表，把「依赖名 → 声明它的根插件 id」建成索引，
    // 避免「根 × 依赖」的 O(n²) 次重复读盘（沙箱实测可达上百条记录）
    const declarers = new Map<string, string[]>()
    for (const [rootId, depNames] of this.buildRootDependencyIndex(data)) {
      for (const depName of depNames) {
        const list = declarers.get(depName) ?? []
        list.push(rootId)
        declarers.set(depName, list)
      }
    }

    const bundled = new Set<string>()
    for (const [depName, ownerIds] of declarers) {
      if (!data.plugins.some((p) => p.name === depName)) continue // 沙箱里没有这个包，无需归并
      const requester = ownerIds[0]
      if (!requester) continue
      for (const name of this.bundleChildrenInData(data, requester, [depName])) bundled.add(name)
    }

    if (bundled.size > 0) this.saveData(data)
    return { scanned: roots.length, bundled: [...bundled] }
  }

  /**
   * 从沙箱移除插件（**完整事务**，删除单位是「组合」）。
   *
   * 旧实现只从 `vault.json` 里 `splice` 一条记录：不卸挂载、不解除 Junction、不删物理目录，
   * 也从不检查「谁依赖它」——这正是「删不掉」与「删了环境打不开」的根因。
   *
   * 组合语义（需求方裁定）：**组合才是删除的单位，删除方向不改变结果**——
   * - 删母即删子：删根插件时连带删除它名下整棵子依赖子树；
   * - 删子即删母：删任意子副本时，连带删除它所属的整个组合（根 + 整棵子树）；
   * - 唯一例外：某子副本被 profile P 链接、而它的根**不在** P 里 → 该子副本保留，
   *   并转成根条目（父已不存在，不转正用户既看不见也管不了），物理目录保留。
   *
   * @param mode  `block`（默认）被组合外的插件依赖时拒绝；`cascade` 连同依赖者的组合一起删；`force` 忽略强删
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
    /** 组合的根条目名（删子时也能看出被删的整个组合是谁） */
    bundleRootName?: string
    /** 本次连带删除的子副本条目 id（不含根），供 UI 说明「连带删了多少」 */
    removedChildren?: string[]
    /** 因语义 3 例外被保留、并转成根条目的子副本条目 id */
    preservedChildren?: string[]
  }> {
    const mode = opts.mode ?? 'block'
    const unmountedFrom: string[] = []

    const data = this.readData()
    const anchor = this.findByRef(data, id)
    if (!anchor) {
      return { ok: false, unmountedFrom, dependents: [], purged: false, error: `沙箱中未找到插件: ${id}` }
    }

    // 组合 = 根 + 整棵子树；传入子副本 id 时同样得到它所属的整个组合（删子即删母）
    const members: VaultPlugin[] = [...this.bundleMembersInData(data, anchor)]
    const root = members[0] ?? anchor
    const memberIds = new Set(members.map((m) => m.id))
    const memberNames = new Set(members.map((m) => m.name))

    // ---- 反向依赖检查（bug 3）----
    // 口径统一到**组合的根**：组合内成员之间的依赖（子依赖父名之类）不算外部依赖者，
    // 否则「删子」会因为它自己的根而永远被 block 挡住，与「组合才是删除单位」自相矛盾。
    const dependents = findDependentsOf(root.name, this.readDependencyIndex(data)).filter(
      (n) => n !== root.name && !memberNames.has(n)
    )
    if (dependents.length > 0 && mode === 'block') {
      return {
        ok: false,
        name: anchor.name,
        unmountedFrom,
        dependents,
        purged: false,
        error:
          `该插件被 ${dependents.length} 个插件依赖（${dependents.join('、')}）。` +
          `删除它会导致这些环境因缺依赖而打不开；如确认请改用级联删除（mode=cascade）`,
      }
    }

    // cascade：连带删除「依赖者」所在的**整个组合**（同样以组合为单位，避免留下孤儿子副本）
    if (mode === 'cascade') {
      for (const name of dependents) {
        const dep = data.plugins.find((p) => !p.parentId && p.name === name)
        if (!dep) continue
        for (const m of this.bundleMembersInData(data, dep)) {
          if (memberIds.has(m.id)) continue
          members.push(m)
          memberIds.add(m.id)
          memberNames.add(m.name)
        }
      }
    }

    // ---- 语义 3 例外判定：必须在**卸载之前**做 ----
    // 反例：先卸载根会把「根在该环境」这个事实抹掉，于是所有同环境的子副本都会被误判成例外而保留，
    // 「删母即删子」当场失效。所以先按当前真实链接状态判定，再决定谁保留、谁进删除名单。
    const links = opts.profilesDir ? this.collectProfileLinks(opts.profilesDir) : null
    const doomed: VaultPlugin[] = []
    const preserved: string[] = []
    for (const m of members) {
      if (!m.parentId) {
        doomed.push(m) // 组合的根（含 cascade 带进来的根）：一定删
        continue
      }
      const ownRoot = data.plugins.find((p) => p.id === m.parentId)
      const ownRootDir = ownRoot ? this.resolvePluginSourceDir(ownRoot) : null
      const relied = links
        ? this.profilesRelyingOnChildWithoutRoot(m, ownRootDir, ownRoot?.name ?? '', links)
        : []
      if (relied.length > 0) {
        // 例外：这个环境还在用它，而它的根不在这个环境 → 转成根条目保留（幂等）
        this.promoteChildToRoot(data, m, relied)
        preserved.push(m.id)
        continue
      }
      doomed.push(m)
    }

    // ---- 1. 先卸载挂载（解除 Junction + 清理声明）----
    // 根按既有语义卸载；被删的子副本也要连同它在环境里的链接一起去掉，否则下一步删掉目录就是死链。
    // 但对子副本只处理「链接指向的正是本组合那份副本」的环境：别的组合的同名副本不能碰。
    if (opts.profilesDir) {
      for (const t of doomed) {
        if (!t.parentId) {
          for (const prof of [...(t.installedProfiles ?? [])]) {
            try {
              await this.unmountFromProfile(t.id, prof, opts.profilesDir)
              unmountedFrom.push(prof)
            } catch {
              /* 单个环境卸载失败不应阻断整体删除，但会在 history 里留痕 */
            }
          }
          continue
        }
        const childDir = this.resolveCombinationMemberDir(t)
        if (!childDir || !links) continue
        const want = resolve(childDir).toLowerCase()
        for (const [prof, map] of links) {
          if (map.get(t.name) !== want) continue
          try {
            await this.unmountFromProfile(t.id, prof, opts.profilesDir)
            unmountedFrom.push(prof)
          } catch {
            /* 同上：单环境失败不阻断整体删除 */
          }
        }
      }
    }

    // ---- 2. 移除索引：按 **id** 精确删除 ----
    // 不能用名字过滤：同名副本可能属于别的组合（A、B 各有一份 `shared-lib`），
    // 按名字删会把另一个组合的那份一起抹掉，等于破坏按父隔离。组合成员已在上面精确列全。
    const doomedIds = new Set(doomed.map((d) => d.id))
    data.plugins = data.plugins.filter((p) => !doomedIds.has(p.id))
    this.saveData(data)

    // ---- 3. 可选物理回收（仅限沙箱池内，绝不触碰 profile 目录）----
    let purged = false
    if (opts.purge) {
      // 惰性收集「仍被某个 profile 链接指着的池目录」：批量删除时只扫一遍环境，而不是每个插件扫一遍。
      // 这份保护是兜底：正常流程上一步已把该组合的链接解除，但若某个环境（在 profilesDir 之外、
      // 或卸载失败）仍链着它，删目录就会制造死链——那种情况一律留给 GC 处理。
      let linkedDirs: Set<string> | null = null
      const stillLinked = (dir: string): boolean => {
        if (!opts.profilesDir) return true // 无法核实 → 保守不删
        linkedDirs ??= this.collectLinkedStoreDirs(opts.profilesDir)
        return linkedDirs.has(resolve(dir).toLowerCase())
      }

      for (const t of doomed) {
        const src = t.parentId ? this.resolveCombinationMemberDir(t) : this.resolvePluginSourceDir(t)
        if (!src || !this.isInsideStoreDir(src)) continue
        if (stillLinked(src)) continue
        removePathSafe(src)
        purged = true
      }
    }

    const history = this.readHistory()
    history.push({
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      profile: unmountedFrom.join(',') || '-',
      pluginId: anchor.id,
      pluginName: anchor.name,
      toVersion: anchor.version,
      action: 'remove',
    })
    this.saveHistory(history)

    return {
      ok: true,
      name: anchor.name,
      unmountedFrom,
      dependents,
      purged,
      bundleRootName: root.name,
      removedChildren: doomed.filter((d) => d.parentId).map((d) => d.id),
      ...(preserved.length > 0 ? { preservedChildren: preserved } : {}),
    }
  }

  /**
   * 批量移除（bug 5）：逐项独立事务，单项失败不影响其余。
   * 返回逐项结果，供任务中心与前端精确展示。
   *
   * **计数口径（需求方裁定）**：一次请求项 = 一个计数单位，`removed/blocked/failed` 都按
   * 「提交的条目数」计。组合级联只是实现细节，自动连带删掉的子副本**不计入** `removed`——
   * 否则前端勾了 3 条却看到「已移除 7 项」，用户会以为删错了。
   *
   * 组合语义带来的一个现实情况：前端把子行也映射成「组合根的 id」，于是一次批量里可能出现
   * 同一个根 id 两次（或根 id 与其子副本 id 同时出现）。这些请求项指向的东西**已经不存在了**，
   * 按用户视角它们是「已移除」，所以这里用「本批次已删掉的条目 id」记账，把这类重复项判为
   * `removed` 而不是报「未找到」的 failed —— 计数仍然严格等于提交的条目数。
   */
  async removeMany(
    ids: string[],
    opts: { mode?: 'block' | 'cascade' | 'force'; purge?: boolean; profilesDir?: string } = {}
  ): Promise<{
    results: {
      id: string
      name?: string
      status: 'removed' | 'blocked' | 'failed'
      reason?: string
      dependents?: string[]
      /** 组合的根条目名（删子时也能看出被删的是哪个组合） */
      bundleRootName?: string
      /** 本条请求连带删掉的子副本数量（仅用于展示，不计入 removed） */
      childrenRemoved?: number
    }[]
    removed: number
    blocked: number
    failed: number
  }> {
    type Item = {
      id: string
      name?: string
      status: 'removed' | 'blocked' | 'failed'
      reason?: string
      dependents?: string[]
      bundleRootName?: string
      childrenRemoved?: number
    }
    const results: Item[] = []
    // 本批次已被连带删掉的条目 id → 展示名。用于把「指向已删条目的重复请求项」判为已移除。
    const deletedRefs = new Map<string, string>()

    for (const id of ids) {
      const alreadyRemoved = deletedRefs.get(id)
      if (alreadyRemoved !== undefined) {
        results.push({ id, name: alreadyRemoved, status: 'removed' })
        continue
      }
      const beforeIds = new Set(this.list().map((p) => p.id))
      try {
        const r = await this.remove(id, opts)
        if (r.ok) {
          const display = r.bundleRootName ?? r.name
          results.push({
            id,
            name: r.name,
            status: 'removed',
            ...(r.bundleRootName ? { bundleRootName: r.bundleRootName } : {}),
            ...(r.removedChildren && r.removedChildren.length > 0 ? { childrenRemoved: r.removedChildren.length } : {}),
          })
          // 记账：用「删除前后的条目 id 差集」记录本条请求实际删掉的每个条目（根 + 整棵子树），
          // 这样同批次里后续指向它们的请求项才能被正确判为「已移除」。
          const afterIds = new Set(this.list().map((p) => p.id))
          for (const pid of beforeIds) {
            if (!afterIds.has(pid) && display) deletedRefs.set(pid, display)
          }
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
    const plugin = this.findByRef(data, id)
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
      const declaredDeps = readPackageDependencySpecs(sourceDir)

      // ---------- 1.5 子依赖归并（第三条规则 / 语义 6）----------
      // 放在这里（干跑校验已过、尚未写盘）而不是更早：归并会改沙箱结构（可能摘掉公共根条目、
      // 复制物理目录），不该因为后面某个伴随依赖缺失、注入被拒而白白留下一次结构变更。
      // 失败必须中止注入：子副本没就绪却继续，等于主动放一个「插件树不完整」的环境出去。
      try {
        // 官方 bundle 永远不该被降格成某个插件的子副本，先剔除。
        // 把根自己记录的 bundledDeps 也一起喂进去：若某条子副本条目被误删，这里能自愈重建
        // （下一段的不变量校验否则会一直拒绝注入，用户无路可走）。
        const bundlingInput = [...declaredDeps.map((d) => d.name), ...(plugin.bundledDeps ?? [])].filter(
          (n) => !OFFICIAL_BUNDLES.has(n)
        )
        const bundled = this.bundleChildrenInData(data, plugin.id, bundlingInput)
        if (bundled.length > 0) this.saveData(data)
      } catch (err) {
        return fail(`子依赖归并失败，已中止注入：${err instanceof Error ? err.message : String(err)}`)
      }

      // ---------- 1.6 组合不变量（语义 4）：母在则子必在 ----------
      // 根插件进环境时，它名下**整棵**子依赖子树都必须同时进；任何一个成员缺条目或缺物理源，
      // 这次注入就整体失败并说明原因 —— 绝不允许根单独进环境（那正是「环境缺依赖打不开」的成因）。
      const combination = this.bundleMembersInData(data, plugin)

      // ① 账实相符：根记录的 bundledDeps 里每个名字都必须有对应的子副本条目
      for (const name of plugin.bundledDeps ?? []) {
        const own = data.plugins.find((p) => p.parentId === plugin.id && p.name === name)
        if (!own) {
          return fail(
            `根插件记录的捆绑子依赖 ${name} 在沙箱中没有对应条目（条目缺失），拒绝注入 ${plugin.name}：` +
              `否则环境会缺该依赖而打不开。请先修复/重新收割该依赖后再试`
          )
        }
      }

      // ② 组合闭包：每个成员「沙箱里确实有」的依赖，都必须已经以子副本形式挂在它自己名下。
      // 这一条堵的是「沙箱里明明有这个包、却没变成子副本」的漏洞——例如共同占有时物理源缺失，
      // 一份副本都没复制出来，此时根照样会被注入，而那个依赖既不是它的子副本、也不再是根条目。
      for (const parentEntry of [plugin, ...combination.filter((m) => m.id !== plugin.id)]) {
        const pSrc = parentEntry.parentId ? this.resolveCombinationMemberDir(parentEntry) : sourceDir
        if (!pSrc) continue // 物理源缺失已由 ③ 报错，这里不重复报
        for (const spec of readPackageDependencySpecs(pSrc)) {
          if (OFFICIAL_BUNDLES.has(spec.name)) continue
          if (data.plugins.some((c) => c.parentId === parentEntry.id && c.name === spec.name)) continue // 已挂上
          if (!data.plugins.some((e) => e.name === spec.name)) continue // 沙箱里没有 → 交给 dsh/pnpm 自行解析
          return fail(
            `依赖 ${spec.name} 在沙箱中存在，却没能成为 ${parentEntry.name} 的子副本（条目或物理源缺失），` +
              `拒绝注入 ${plugin.name}：否则环境会缺该依赖而打不开。请先修复沙箱副本后再试`
          )
        }
      }

      // ③ 物理就绪：组合里每个子成员都必须有可用的物理源，且记录各自的声明范围用于写 dependencies
      const rangeCache = new Map<string, { name: string; range: string }[]>()
      const declaredRangeOf = (parentEntry: VaultPlugin, depName: string): string | null => {
        let specs = rangeCache.get(parentEntry.id)
        if (!specs) {
          const pSrc = parentEntry.parentId
            ? this.resolveCombinationMemberDir(parentEntry)
            : this.resolvePluginSourceDir(parentEntry)
          specs = pSrc ? readPackageDependencySpecs(pSrc) : []
          rangeCache.set(parentEntry.id, specs)
        }
        return specs.find((s) => s.name === depName)?.range ?? null
      }

      const derivedCompanions: string[] = []
      for (const member of combination) {
        if (member.id === plugin.id) continue // 根自己走既有逻辑
        if (OFFICIAL_BUNDLES.has(member.name)) continue
        if (companionPlans.some((c) => c.name === member.name)) continue // 契约伴随已计划

        // 子副本只认自己那份按父隔离的目录：绝不回退到同名公共/别人的目录
        const memberSrc = this.resolveCombinationMemberDir(member)
        if (!memberSrc) {
          return fail(
            `组合成员 ${member.name} 的物理源缺失（条目 ${member.id} 的 sourcePath 不可读），` +
              `拒绝注入 ${plugin.name}：否则环境会缺该依赖而打不开。请先修复沙箱副本（重新归并/收割）后再试`
          )
        }
        const memberDest = join(profileNm, ...member.name.split('/'))
        if (resolve(memberSrc).toLowerCase() === resolve(memberDest).toLowerCase()) {
          return fail(`组合成员 ${member.name} 的物理源就是目标环境自身，拒绝注入`)
        }

        // 已就绪判定必须看「环境里当前到底链到了哪一份」：
        // 旧实现写成「deps 里声明了该依赖 && 物理能解析到 package.json 就 continue」，
        // 这个判定发生在「该用哪份子副本」之前，于是同一个环境里注入第二个父时直接早退 ——
        // 链接仍指着第一个父的副本，等第一个父被删掉，链接就成了死链而声明还在，环境打不开（I1）。
        // 注意「能不能解析到」这件事本身不足以判断：无论是 A 的副本、B 的副本还是断链，
        // 只要还有 package.json 就能解析成功，所以只认 realpath 出来的真实目标。
        const parentEntry = data.plugins.find((p) => p.id === member.parentId)
        const range = parentEntry ? declaredRangeOf(parentEntry, member.name) : null
        if (isProfileLinkedTo(profileDir, member.name, memberSrc) && Object.hasOwn(deps, member.name)) continue

        const memberKind = readPackageKind(memberSrc)
        companionPlans.push({
          name: member.name,
          // 优先沿用声明它的那一层插件写下的版本范围，避免凭空造出一个可能与上游要求冲突的范围
          version: range || (member.version ? `^${member.version}` : '*'),
          isBundle: memberKind === 'bundle' || memberKind === 'both',
          src: memberSrc,
        })
        derivedCompanions.push(member.name)
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
    const plugin = this.findByRef(data, id)
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
    const plugin = this.findByRef(data, id)
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
   * 扫描所有 Profile 的 `node_modules`，得到「profile → 包名 → 真实目标目录（小写绝对路径）」。
   *
   * 为什么要 profile 维度而不是一个目录集合：判定语义 3 的例外时必须**同时**看两件事 ——
   * 该子副本是否被这个环境链接、以及这个环境里有没有它的根。集合形式丢掉了 profile 维度，
   * 无法回答「同一个环境里根在不在」。
   * 目标一律取 realpath：取不到（断链 / 不存在 / 权限）就不记，那是「没有有效目标」，
   * 不是「已就绪」——用存在性判活正是死链蒙混过关的老路。
   */
  private collectProfileLinks(profilesDir: string): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>()
    let profiles: string[]
    try {
      profiles = readdirSync(profilesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return out
    }
    for (const prof of profiles) {
      const nm = join(profilesDir, prof, 'node_modules')
      if (!existsSync(nm)) continue
      const links = new Map<string, string>()
      const consider = (name: string, p: string) => {
        try {
          if (!lstatSync(p).isSymbolicLink()) return
          const target = realpathSync(p)
          if (this.isInsideStoreDir(target)) links.set(name, resolve(target).toLowerCase())
        } catch {
          /* 死链本身就取不到 realpath：不记录，调用方按「没有有效目标」处理 */
        }
      }
      try {
        for (const entry of readdirSync(nm, { withFileTypes: true })) {
          const p = join(nm, entry.name)
          if (entry.name.startsWith('@')) {
            try {
              for (const sub of readdirSync(p, { withFileTypes: true })) {
                consider(`${entry.name}/${sub.name}`, join(p, sub.name))
              }
            } catch {}
          } else {
            consider(entry.name, p)
          }
        }
      } catch {}
      out.set(prof, links)
    }
    return out
  }

  /**
   * 收集所有 Profile 的 `node_modules` 中、指向沙箱池内的链接目标目录（小写绝对路径）。
   *
   * 用途（bug 5 收尾）：GC 删池目录前必须先知道「谁还链着它」。
   * 旧实现只按「是否被某条索引记录解析到」判断，于是删掉一个记录后池目录被判为孤儿并删除，
   * 而 Profile 里指向它的 junction 立刻变成**死链** —— 这就是「删完再点沙箱大扫除 → 环境打不开」的成因。
   *
   * 实现上直接复用 `collectProfileLinks`，避免两处各写一遍 node_modules 遍历而漂移。
   */
  private collectLinkedStoreDirs(profilesDir: string): Set<string> {
    const out = new Set<string>()
    for (const links of this.collectProfileLinks(profilesDir).values()) {
      for (const dir of links.values()) out.add(dir)
    }
    return out
  }

  /**
   * 语义 3 的例外判定：找出「链接了这个子副本、但**没有**它的根」的 profile 列表。
   *
   * 两个条件都基于 realpath 的真实状态：
   * ① `links[profile][child.name]` 必须正好等于**这一份**子副本的目录（别人的同名副本不算）；
   * ② 同一个 profile 里根插件的链接必须**不在**（或指向别的目录）——否则根就在这个环境里，
   *    不在例外范围（那种情况下删母即删子）。
   * 返回排序后的 profile 名，保证「转根条目」的写入是幂等的、可断言的。
   */
  private profilesRelyingOnChildWithoutRoot(
    child: VaultPlugin,
    rootDir: string | null,
    rootName: string,
    links: Map<string, Map<string, string>>
  ): string[] {
    const childDir = this.resolveCombinationMemberDir(child)
    if (!childDir) return [] // 连物理目录都没有 → 谈不上「环境还依赖它」
    const wantChild = resolve(childDir).toLowerCase()
    const wantRoot = rootDir ? resolve(rootDir).toLowerCase() : null
    const out: string[] = []
    for (const [prof, map] of links) {
      if (map.get(child.name) !== wantChild) continue
      if (wantRoot !== null && map.get(rootName) === wantRoot) continue // 根也在同一个环境 → 非例外
      out.push(prof)
    }
    return out.sort()
  }

  /**
   * 把「根已不存在、但仍被某环境依赖」的子副本**转成根条目**（语义 3）。
   *
   * 为什么必须转正而不是留着：父没了，它还挂着 `parentId` 就既不会被 GC 当有效条目，
   * 也不会出现在根列表里——用户既看不见也管不了它。转正后它按正常根条目管理，
   * 物理目录保留，环境继续可用。
   *
   * 幂等：所有字段都由当前数据**重新算出来**（子树名清单排序、profile 列表排序），
   * 重复调用/重复 GC 不会反复改写，也不会产生脏数据。返回是否真的改动了什么。
   */
  private promoteChildToRoot(data: VaultDataFile, child: VaultPlugin, profiles: string[]): boolean {
    const childNames = [...new Set(data.plugins.filter((p) => p.parentId === child.id).map((c) => c.name))].sort()
    const sameNames = JSON.stringify([...(child.bundledDeps ?? [])].sort()) === JSON.stringify(childNames)
    const sameProfiles = JSON.stringify([...(child.installedProfiles ?? [])].sort()) === JSON.stringify(profiles)
    const alreadyRoot = child.parentId === undefined && child.childOrigin === undefined
    if (alreadyRoot && sameNames && sameProfiles) return false

    delete child.parentId
    delete child.childOrigin
    // 转正后的它就是自己那棵子树的根，bundledDeps 的口径与普通根条目一致
    child.bundledDeps = childNames
    // 记账：这个环境确实在用它的物理副本，后续卸载/同步要认这份账
    child.installedProfiles = profiles
    return true
  }

  /** 从「根」出发可达的全部条目 id（根 + 整棵子树）。用于判断谁还是有效条目、谁是孤儿。 */
  private computeAliveIds(data: VaultDataFile): Set<string> {
    const alive = new Set<string>()
    const queue = data.plugins.filter((p) => !p.parentId).map((p) => p.id)
    while (queue.length > 0) {
      const id = queue.pop()
      if (!id || alive.has(id)) continue
      alive.add(id)
      for (const p of data.plugins) {
        if (p.parentId === id) queue.push(p.id)
      }
    }
    return alive
  }

  /**
   * 沙箱垃圾大扫除（组合语义，与非 GC 删除路径一视同仁）。
   *
   * 语义 5 要求 GC 与单独删除对称：
   * - 根还在的子副本**不得**回收（它们是组合的一部分）；
   * - 根已不在、且不满足语义 3 例外的子副本**不得留下**（索引条目与物理目录一并回收）；
   * - 满足例外的（仍被某环境依赖而根不在那个环境）→ 转成根条目保留，物理目录保留。
   *
   * 返回值结构保持不变，仅新增可选字段 `promotedRoots` 说明本次转正了哪些条目。
   */
  async garbageCollect(
    profilesDir: string
  ): Promise<{ freedBytes: number; removedDirs: string[]; keptDirs: string[]; promotedRoots?: string[] }> {
    const data = this.readData()
    const links = this.collectProfileLinks(profilesDir)
    const promotedRoots: string[] = []
    let indexChanged = false

    // ---- 1. 先按组合语义整理索引：孤儿转正或回收 ----
    // 循环直到稳定：转正会让它的整棵子树重新「有根」，回收又可能让更深的条目变成孤儿，
    // 所以每轮都要基于最新的「可达集合」重新判定。轮数上限只是防御脏数据成环。
    for (let pass = 0; pass < 64; pass++) {
      const alive = this.computeAliveIds(data)
      const orphans = data.plugins.filter((p) => p.parentId && !alive.has(p.id))
      if (orphans.length === 0) break

      const promotable = orphans.filter(
        (c) => this.profilesRelyingOnChildWithoutRoot(c, null, '', links).length > 0
      )
      if (promotable.length > 0) {
        for (const c of promotable) {
          const profs = this.profilesRelyingOnChildWithoutRoot(c, null, '', links)
          if (this.promoteChildToRoot(data, c, profs)) indexChanged = true
          promotedRoots.push(c.name)
        }
        continue // 转正后可达集合变了，重新判定
      }

      // 剩下的都是「根不在、也没人依赖」的孤儿：索引与物理一并回收（与单独删除同一口径）
      const orphanIds = new Set(orphans.map((c) => c.id))
      data.plugins = data.plugins.filter((p) => !orphanIds.has(p.id))
      indexChanged = true
    }
    if (indexChanged) this.saveData(data)

    // ---- 2. 物理清理：只有「有效条目（根 + 其子树）解析得到的目录」才算在用 ----
    const activeDirs = new Set<string>()
    for (const p of data.plugins) {
      const dir = this.resolveCombinationMemberDir(p)
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

    return { freedBytes, removedDirs, keptDirs, ...(promotedRoots.length > 0 ? { promotedRoots } : {}) }
  }

  /**
   * 异步并发静默检查沙箱插件是否有新版本（零阻塞主事件循环）
   */
  async checkUpdates(): Promise<{ id: string; hasUpdate: boolean; latestVersion?: string }[]> {
    const data = this.readData()
    // 共同占有的子副本（childOrigin=shared-copy）不参与版本自更新：
    // updatePlugin 会把它的 sourcePath 指回池里那个按包名命名的**公共**目录 `<dep>@<ver>`，
    // 于是两个父的副本又指向同一条物理路径，按父隔离的前提当场失效
    // （之后删掉任何一个父都会连带毁掉另一个父的依赖）。
    // standalone 那份本来就是独占目录，保持既有可更新语义不变。
    const toCheck = data.plugins.filter((p) => p.source !== 'local' && p.childOrigin !== 'shared-copy')
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
    // 只复用根条目：若按名命中的是某个父名下的子副本，后面的写入会把它的 sourcePath
    // 指回公共池目录（`<name>@<ver>`），两个父的副本重新共用一条物理路径，按父隔离当场失效（I4）
    let plugin = this.findByRef(data, pluginName)

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
    const plugin = this.findByRef(data, id)
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
    // 二次过滤 shared-copy 子副本：历史数据里可能残留 hasUpdate=true（checkUpdates 已不再标记它们），
    // 只靠上一步的过滤挡不住旧标记，这里再挡一次，避免升级动作破坏按父隔离。
    const needUpdate = data.plugins.filter(
      (p) => p.hasUpdate && p.latestVersion && p.childOrigin !== 'shared-copy'
    )

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


