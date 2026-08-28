export interface MarketPlugin {
  name: string
  version?: string
  description?: string
  homepage?: string
  repository?: string
  tags?: string[]
  author?: string | { name?: string; email?: string }
  [key: string]: unknown
}

export interface MarketIndex {
  plugins: MarketPlugin[]
}
