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

/** 一键环境配置包格式定义（用于环境备份、分享、导入与快速复现） */
export interface ProfilePackage {
  format: 'godsh-profile-package'
  version: string
  name: string
  exportedAt: number
  description?: string
  bundles: string[]
  dependencies: Record<string, string>
  patchYaml: string
  workspaceYaml?: string
}

