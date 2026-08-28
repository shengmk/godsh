import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatchSummary } from './patch.js'
import type { ProfileInfo, ProfileManifest } from './types.js'

/**
 * Profile 扫描缓存：避免 3s 轮询时反复读磁盘。
 * 缓存键 = profilesDir，值 = { profiles, mtime 签名 }；TTL 1s + 目录 mtime 变化双重失效。
 * 写回方（分配/统一内核/新建/删除）应调用 invalidateProfileCache 主动失效。
 */
interface CacheEntry {
  at: number
  signature: string
  profiles: ProfileInfo[]
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 1000

function dirSignature(profilesDir: string): string {
  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true })
    let sig = ''
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules') continue
      let mtime = 0
      try {
        mtime = statSync(join(profilesDir, e.name, 'package.json')).mtimeMs
      } catch {
        mtime = 0
      }
      sig += `${e.name}:${Math.round(mtime)}\n`
    }
    return sig
  } catch {
    return ''
  }
}

/** 主动失效某（或全部）profilesDir 的扫描缓存（分配写回/新建/删除后调用）。 */
export function invalidateProfileCache(profilesDir?: string): void {
  if (profilesDir) cache.delete(profilesDir)
  else cache.clear()
}

/** 扫描 $DSH_HOME/profiles/ 下所有 Profile（带 1s TTL + 目录 mtime 缓存）。 */
export function scanProfiles(profilesDir: string): ProfileInfo[] {
  if (!existsSync(profilesDir)) return []
  const now = Date.now()
  const cached = cache.get(profilesDir)
  const sig = dirSignature(profilesDir)
  if (cached && now - cached.at < CACHE_TTL_MS && cached.signature === sig) {
    return cached.profiles
  }
  const entries = readdirSync(profilesDir, { withFileTypes: true })
  const profiles: ProfileInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules') continue

    const dir = join(profilesDir, entry.name)
    const packageJsonPath = join(dir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      profiles.push({
        name: entry.name,
        dir,
        packageJsonPath,
        exists: false,
        manifest: null,
        bundles: [],
        dependencies: {},
        patchPath: null,
        patchEntries: 0,
        patchDisabled: [],
        error: '缺少 package.json',
      })
      continue
    }

    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as ProfileManifest
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const dependencies = manifest.dependencies ?? {}

      const patchPath = join(dir, 'cordis.patch.yml')
      let patchEntries = 0
      let patchDisabled: string[] = []
      if (existsSync(patchPath)) {
        const summary = parsePatchSummary(readFileSync(patchPath, 'utf8'))
        patchEntries = summary.entries
        patchDisabled = summary.disabledIds
      }

      profiles.push({
        name: entry.name,
        dir,
        packageJsonPath,
        exists: true,
        manifest,
        bundles,
        dependencies,
        patchPath: existsSync(patchPath) ? patchPath : null,
        patchEntries,
        patchDisabled,
      })
    } catch (err) {
      profiles.push({
        name: entry.name,
        dir,
        packageJsonPath,
        exists: true,
        manifest: null,
        bundles: [],
        dependencies: {},
        patchPath: null,
        patchEntries: 0,
        patchDisabled: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const result = profiles.sort((a, b) => a.name.localeCompare(b.name))
  cache.set(profilesDir, { at: now, signature: sig, profiles: result })
  return result
}

export function findProfile(profilesDir: string, name: string): ProfileInfo | null {
  return scanProfiles(profilesDir).find((p) => p.name === name) ?? null
}
