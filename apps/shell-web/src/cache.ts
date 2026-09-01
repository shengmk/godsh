/**
 * 内存数据缓存层（TTL 控制 + 主动失效）
 * 解决切换页面或重复进入时瞬间闪白/重复打接口问题。
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const memoryCache = new Map<string, CacheEntry<unknown>>()

export const dataCache = {
  get<T>(key: string): T | null {
    const entry = memoryCache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      memoryCache.delete(key)
      return null
    }
    return entry.data as T
  },

  set<T>(key: string, data: T, ttlMs = 30000): void {
    memoryCache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    })
  },

  invalidate(keyPrefix?: string): void {
    if (!keyPrefix) {
      memoryCache.clear()
      return
    }
    for (const k of memoryCache.keys()) {
      if (k.startsWith(keyPrefix)) {
        memoryCache.delete(k)
      }
    }
  },
}
