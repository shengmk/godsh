export interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
}

export interface ProfileInfo {
  name: string
  dir: string
  packageJsonPath: string
  exists: boolean
  manifest: ProfileManifest | null
  bundles: string[]
  dependencies: Record<string, string>
  patchPath: string | null
  patchEntries: number
  patchDisabled: string[]
  error?: string
}

export interface PatchEntry {
  op: string
  ids: string[]
  disabledIds: string[]
}
