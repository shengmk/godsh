export interface CordisContext {
  emit(event: string, ...args: unknown[]): boolean
  on(event: string, listener: (...args: any[]) => void): () => void
  plugin(plugin: unknown, config?: unknown): void
  provide(name: string): void
  [key: string]: unknown
}

export interface AgentToolParamProperty {
  type: string
  description?: string
  enum?: string[]
}

export interface AgentToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, AgentToolParamProperty>
    required?: string[]
  }
  handler: (args: Record<string, any>) => Promise<unknown>
}

export interface SnapshotMeta {
  id: string
  profile: string
  timestamp: number
  tag?: string
  bundles: string[]
  dependencies: Record<string, string>
  patchContent: string
}

export interface MemoryPattern {
  id: string
  profile: string
  type: 'workflow' | 'install' | 'patch' | 'error_fix'
  action: string
  timestamp: number
  details: Record<string, unknown>
  summary: string
}
