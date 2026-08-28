import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginInfo, PluginKind, PluginManifest } from './types.js'

/** 根据 package.json 的 dsh 字段判定插件类型。 */
export function detectKind(manifest: PluginManifest): PluginKind {
  const bundle = Boolean(manifest.dsh?.bundle)
  const client = Boolean(manifest.dsh?.client)
  if (bundle && client) return 'both'
  if (bundle) return 'bundle'
  if (client) return 'client'
  return 'unknown'
}

export function inspectManifest(manifest: PluginManifest): Omit<PluginInfo, 'name' | 'dir' | 'error'> {
  return {
    version: manifest.version ?? null,
    kind: detectKind(manifest),
    bundlePatch: manifest.dsh?.bundle?.patch ?? null,
    clientPlatform: manifest.dsh?.client?.platform ?? null,
    clientInject: manifest.dsh?.client?.inject ?? [],
  }
}

/** 扫描本地 plugins/ 目录，识别 bundle / client 插件。 */
export function scanLocalPlugins(pluginsDir: string): PluginInfo[] {
  if (!existsSync(pluginsDir)) return []
  const entries = readdirSync(pluginsDir, { withFileTypes: true })
  const plugins: PluginInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(pluginsDir, entry.name)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    try {
      const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as PluginManifest
      const info = inspectManifest(manifest)
      plugins.push({
        name: manifest.name ?? entry.name,
        dir,
        ...info,
      })
    } catch (err) {
      plugins.push({
        name: entry.name,
        dir,
        version: null,
        kind: 'unknown',
        bundlePatch: null,
        clientPlatform: null,
        clientInject: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}
