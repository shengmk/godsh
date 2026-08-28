export type SourceKind = 'registry' | 'git' | 'local' | 'unknown'

export interface SourceDecision {
  allowed: boolean
  reason: string
}
