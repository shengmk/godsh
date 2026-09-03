import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR, runSync } from '@godsh/core'
import { setProfileBundles } from '@godsh/profile-manager'
import { inspectManifest } from './bundle.js'
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
}

interface VaultDataFile {
  version: string
  updatedAt: number
  plugins: VaultPlugin[]
}

/** 常见服务插件伴随契约库（防缺失断链） */
export const KNOWN_COMPANIONS: Record<string, { pkg: string; version: string; isBundle: boolean }[]> = {
  'dsh-web-search-pro': [{ pkg: '@anweat/dsh-browser', version: '^0.1.10', isBundle: true }],
}

export class VaultManager {
  private dataFile: string
  private storeDir: string

  constructor(dataDir = DATA_DIR) {
    this.dataFile = join(dataDir, 'vault.json')
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

  list(): VaultPlugin[] {
    return this.readData().plugins
  }

  /**
   * 本地插件导入：
   * 自动探测 targetPath 目录下的 package.json，识别 bundle/client 类型，
   * 并缓存到 vault_store 中登记为就绪态插件。
   */
  async importLocal(targetPath: string, category = 'local'): Promise<VaultPlugin> {
    if (!existsSync(targetPath)) {
      throw new Error(`本地路径不存在: ${targetPath}`)
    }

    let pkgJsonPath = join(targetPath, 'package.json')
    let actualDir = targetPath

    // 若当前路径无 package.json，向下探测一级目录
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
    const destDir = join(this.storeDir, `local-${sanitized}@${version}`)
    mkdirSync(destDir, { recursive: true })

    try {
      cpSync(actualDir, destDir, { recursive: true })
    } catch {
      // 降级软链
    }

    const data = this.readData()
    const id = `vault-local-${sanitized}`
    const existingIdx = data.plugins.findIndex((p) => p.id === id || p.name === name)

    const plugin: VaultPlugin = {
      id,
      name,
      version,
      kind: info.kind,
      source: 'local',
      sourcePath: actualDir,
      category,
      description: typeof (manifest as Record<string, unknown>).description === 'string'
        ? ((manifest as Record<string, unknown>).description as string)
        : '本地导入插件',
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
      stagedAt: Date.now(),
    }

    data.plugins.push(plugin)
    this.saveData(data)
    return plugin
  }

  /**
   * 从沙箱移除
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
   * 秒级部署沙箱插件到指定 Profile（支持伴随服务自愈）
   */
  async deployToProfile(
    id: string,
    targetProfile: string,
    profilesDir: string,
  ): Promise<{ ok: boolean; deployed: string[]; companionAdded?: string[] }> {
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
    const deployed = [plugin.name]
    const companionAdded: string[] = []

    // 1. 注入目标插件
    pkg.dependencies[plugin.name] = plugin.version.startsWith('^') ? plugin.version : `^${plugin.version}`

    // 2. 伴随依赖自愈（如 dsh-web-search-pro 联动注入 @anweat/dsh-browser）
    const companions = KNOWN_COMPANIONS[plugin.name] || []
    for (const comp of companions) {
      if (!pkg.dependencies[comp.pkg]) {
        pkg.dependencies[comp.pkg] = comp.version
        companionAdded.push(comp.pkg)
      }
    }

    // 3. 维护 bundles 数组
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

    // 记录已分配环境
    plugin.installedProfiles = plugin.installedProfiles || []
    if (!plugin.installedProfiles.includes(targetProfile)) {
      plugin.installedProfiles.push(targetProfile)
      this.saveData(data)
    }

    return { ok: true, deployed, companionAdded }
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
}
