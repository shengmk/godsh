import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatchSummary } from './patch.js'
import type { ProfileInfo, ProfileManifest } from './types.js'

/** 扫描 $DSH_HOME/profiles/ 下所有 Profile，读取 package.json 与 cordis.patch.yml。 */
export function scanProfiles(profilesDir: string): ProfileInfo[] {
  if (!existsSync(profilesDir)) return []
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

  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

export function findProfile(profilesDir: string, name: string): ProfileInfo | null {
  return scanProfiles(profilesDir).find((p) => p.name === name) ?? null
}
