export type KernelType = 'web' | 'headless' | 'node-runtime' | 'python-runtime'

export interface KernelTemplate {
  id: string
  type: KernelType
  name: string
  entry?: string
  command?: string[]
  defaultPort?: number
  resource?: { memoryMB?: number; cpu?: number }
}

export type KernelStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface KernelInstance {
  id: string
  templateId: string
  name: string
  profile?: string
  port?: number
  status: KernelStatus
  pid?: number | null
  createdAt: string
  error?: string
}
