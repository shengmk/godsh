import { useEffect, useRef } from 'react'

/**
 * 全局刷新总线（bug 7）。
 *
 * 写法与 tasks.ts 的单例一致：模块级监听器集合 + subscribe / notify。
 *
 * 背景：KeepAlive 让访问过的页面常驻内存，切换页面**不会**重新拉取数据，
 * 所以需要一个显式的刷新通道：
 * - 每个页面用 usePageRefresh(load, key) 注册自己的「重新加载」函数（不新增任何请求逻辑）；
 * - 顶栏的全局刷新按钮（App.tsx）调用 triggerRefresh() 触发全部页面；
 * - triggerRefresh(key) 只触发某个页面（KeepAlive 页面重新可见且数据已过期时使用）。
 */

export type RefreshHandler = () => void | Promise<void>

interface RefreshEntry {
  /** 页面标识（如 'profiles'）；不传表示响应任意定向刷新 */
  key?: string
  handler: RefreshHandler
}

const entries = new Set<RefreshEntry>()

/** 注册一个刷新回调，返回取消注册函数。 */
export function subscribeRefresh(handler: RefreshHandler, key?: string): () => void {
  const entry: RefreshEntry = { key, handler }
  entries.add(entry)
  return () => {
    entries.delete(entry)
  }
}

/**
 * 触发刷新：
 * - 不传 key → 触发全部已注册页面（顶栏全局刷新按钮）；
 * - 传 key → 只触发该页面的回调（以及未声明 key 的回调）。
 * 单个回调抛错不影响其它页面。
 */
export function triggerRefresh(key?: string): void {
  for (const entry of Array.from(entries)) {
    if (key && entry.key && entry.key !== key) continue
    try {
      void entry.handler()
    } catch (e) {
      console.warn('页面刷新失败', e)
    }
  }
}

/** 当前已注册的刷新回调数量。 */
export function refreshHandlerCount(): number {
  return entries.size
}

/**
 * 页面注册刷新回调的 Hook。
 * 用 ref 持有最新的 handler，避免每次渲染都重新注册（KeepAlive 页面常驻，注册只做一次）。
 */
export function usePageRefresh(handler: RefreshHandler, key?: string): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => subscribeRefresh(() => ref.current(), key), [key])
}
