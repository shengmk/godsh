export type PluginKind = 'bundle' | 'client' | 'both' | 'unknown'

export interface PluginManifest {
  name?: string
  version?: string
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; inject?: string[] }
  }
}

export interface PluginInfo {
  name: string
  dir: string
  version: string | null
  kind: PluginKind
  bundlePatch: string | null
  clientPlatform: string | null
  clientInject: string[]
  error?: string
}
