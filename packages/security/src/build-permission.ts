import type { ConfigStore } from '@godsh/core'
import type { SourceKind } from './types.js'
import { classifySource } from './source-policy.js'

interface BuildPermissionState {
  /** 显式允许执行构建脚本（prepare）的依赖列表。 */
  allowBuilds: string[]
  /** 显式拒绝的依赖列表。 */
  deniedBuilds: string[]
}

/**
 * pnpm 默认阻止 git 依赖的 prepare 构建脚本。
 * 这里维护 allowBuilds 白名单，供 UI 展示与后续写入 pnpm.allowBuilds 使用。
 */
export class BuildPermission {
  private static FILE = 'build-permissions.json'

  constructor(private store: ConfigStore) {}

  private state(): BuildPermissionState {
    return this.store.read<BuildPermissionState>(BuildPermission.FILE, { allowBuilds: [], deniedBuilds: [] })
  }

  allow(pkg: string): void {
    const s = this.state()
    if (!s.allowBuilds.includes(pkg)) s.allowBuilds.push(pkg)
    this.store.write(BuildPermission.FILE, s)
  }

  deny(pkg: string): void {
    const s = this.state()
    if (!s.deniedBuilds.includes(pkg)) s.deniedBuilds.push(pkg)
    this.store.write(BuildPermission.FILE, s)
  }

  isAllowed(pkg: string): boolean {
    return this.state().allowBuilds.includes(pkg)
  }

  /** 判断某来源是否需要授权构建脚本（git 依赖默认需要）。 */
  requiresApproval(spec: string): boolean {
    return classifySource(spec) as SourceKind === 'git'
  }
}
