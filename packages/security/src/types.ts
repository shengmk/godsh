export type SourceKind = 'registry' | 'git' | 'local' | 'unknown'

export interface SourceDecision {
  allowed: boolean
  reason: string
}

export type SecurityLevel = 'official' | 'safe' | 'warning' | 'danger'

export interface AuditFinding {
  ruleId: string
  severity: 'info' | 'warning' | 'danger'
  file: string
  line: number
  snippet: string
  message: string
}

export interface PluginAuditReport {
  pluginId: string
  pluginName: string
  version: string
  level: SecurityLevel
  score: number // 0-100
  findings: AuditFinding[]
  scannedFiles: number
  auditedAt: number
}

