import type { SourceDecision, SourceKind } from './types.js'

/** 判定一个插件来源类型（registry / git / local）。 */
export function classifySource(spec: string): SourceKind {
  if (/^(git\+|https?:\/\/|git@|ssh:\/\/)/i.test(spec)) return 'git'
  if (/^(file:|link:|\.{1,2}[\\/])/i.test(spec)) return 'local'
  if (/^(@?[a-zA-Z0-9._-]+\/?)+$/.test(spec) || spec.includes('/')) return 'registry'
  return 'unknown'
}

/**
 * 来源白名单策略：默认只允许 registry 与 local 来源。
 * git 来源需要显式加入 allowGit 列表（默认禁止其 prepare 构建脚本）。
 */
export class SourcePolicy {
  constructor(private options: { allowGit?: string[] } = {}) {}

  check(spec: string): SourceDecision {
    const kind = classifySource(spec)
    switch (kind) {
      case 'registry':
      case 'local':
        return { allowed: true, reason: `${kind} 来源默认允许` }
      case 'git': {
        const allowed = this.options.allowGit ?? []
        const match = allowed.some((prefix) => spec.startsWith(prefix))
        return match
          ? { allowed: true, reason: 'git 来源在白名单内' }
          : { allowed: false, reason: `git 来源未授权: ${spec}（需加入 allowGit 白名单）` }
      }
      default:
        return { allowed: false, reason: `无法识别的来源: ${spec}` }
    }
  }
}
