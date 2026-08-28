import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MarketIndex, MarketPlugin } from './types.js'

/** 市场本地缓存：7 天内免重新下载（存 data/cache/market.json）。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function marketCachePath(cacheDir: string): string {
  return join(cacheDir, 'market.json')
}

function readMarketCache(cacheDir: string): { plugins: MarketPlugin[] } | null {
  try {
    const p = marketCachePath(cacheDir)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: number; plugins?: MarketPlugin[] }
    if (!Array.isArray(raw.plugins)) return null
    // 过期视为无效
    if (raw.fetchedAt && Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null
    return { plugins: raw.plugins }
  } catch {
    return null // 损坏回退网络
  }
}

function writeMarketCache(cacheDir: string, plugins: MarketPlugin[]): void {
  try {
    const p = marketCachePath(cacheDir)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), plugins }, null, 2), 'utf8')
  } catch {
    /* 缓存写失败不阻断 */
  }
}

/** 从市场数据源（awesome-dsh-plugin）拉取插件索引；cacheDir 提供时走本地缓存（7 天 TTL）。 */
export async function fetchMarketIndex(url: string, timeoutMs = 15000, cacheDir?: string): Promise<MarketIndex> {
  // 本地缓存命中：免下载
  if (cacheDir) {
    const cached = readMarketCache(cacheDir)
    if (cached) return { plugins: cached.plugins }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`拉取插件索引失败: HTTP ${res.status}`)

  const data: unknown = await res.json()
  let plugins: MarketPlugin[] | null = null
  if (Array.isArray(data)) {
    plugins = data as MarketPlugin[]
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.plugins)) plugins = obj.plugins as MarketPlugin[]
    else if (Array.isArray(obj.items)) plugins = obj.items as MarketPlugin[]
  }
  if (!plugins) throw new Error('插件索引格式无法识别（期望数组或 { plugins: [...] }）')

  // 拉取成功写本地缓存；失败回退旧缓存（若有）
  if (cacheDir) writeMarketCache(cacheDir, plugins)
  return { plugins }
}
