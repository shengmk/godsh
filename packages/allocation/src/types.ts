export interface Allocation {
  id: string
  profile: string
  pluginId: string
  pluginName: string
  enabled: boolean
  order: number
  config?: Record<string, unknown>
}
