import type { MarketIndex, MarketPlugin } from './types.js'

/** 从市场数据源（awesome-dsh-plugin）拉取插件索引。 */
export async function fetchMarketIndex(url: string, timeoutMs = 15000): Promise<MarketIndex> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`拉取插件索引失败: HTTP ${res.status}`)

  const data: unknown = await res.json()
  if (Array.isArray(data)) return { plugins: data as MarketPlugin[] }

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.plugins)) return { plugins: obj.plugins as MarketPlugin[] }
    if (Array.isArray(obj.items)) return { plugins: obj.items as MarketPlugin[] }
  }

  throw new Error('插件索引格式无法识别（期望数组或 { plugins: [...] }）')
}
