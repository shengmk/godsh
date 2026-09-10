import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastState {
  text: string
  error?: boolean
}

export interface ToastItem extends ToastState {
  id: number
}

/**
 * 全局 Toast 队列（U4）。
 *
 * 起因：原先每个页面各自 `useState` 一份单槽 toast，并发操作时**后一条会把前一条顶掉**，
 * 用户看不到先失败的那条；而且提示节点没有 `role`/`aria-live`，屏幕阅读器完全读不到。
 *
 * 改法：状态提升到模块级队列 + 订阅，页面侧 API 完全不变（仍是 `useToast().show(...)`），
 * 因此 8 个页面只需把渲染那一行换成共享的 <ToastStack />。
 * 同一时刻最多展示 3 条，错误提示停留更久（6s vs 4.2s）。
 */
const MAX_VISIBLE = 3
const INFO_MS = 4200
const ERROR_MS = 6000

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<(list: ToastItem[]) => void>()

function emit() {
  for (const listener of Array.from(listeners)) listener(items)
}

function dismissToast(id: number) {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

function pushToast(text: string, error: boolean) {
  const item: ToastItem = { id: nextId++, text, error }
  items = [...items, item]
  if (items.length > MAX_VISIBLE) items = items.slice(-MAX_VISIBLE)
  emit()
  setTimeout(() => dismissToast(item.id), error ? ERROR_MS : INFO_MS)
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>(items)

  useEffect(() => {
    listeners.add(setToasts)
    setToasts(items)
    return () => {
      listeners.delete(setToasts)
    }
  }, [])

  const show = useCallback((text: string, error = false) => pushToast(text, error), [])

  // toast 保留为「最新一条」的兼容视图；新代码请用 toasts + <ToastStack />
  const toast: ToastState | null = toasts.length ? toasts[toasts.length - 1]! : null

  return { toast, toasts, show }
}

/** useAsyncAction 的展示配置：复用页面既有的 useToast().show，保证提示口径一致。 */
export interface AsyncActionConfig<TResult> {
  /** 页面既有的 toast 展示函数（useToast().show）；不传则只在 error 状态里暴露失败原因 */
  show?: (text: string, error?: boolean) => void
  /** 成功提示：固定文案，或由返回值生成 */
  success?: string | ((result: TResult) => string)
  /** 失败提示前缀，便于用户分辨是哪个操作失败（如 '导入失败：'） */
  errorPrefix?: string
}

export interface AsyncActionResult<TArgs extends unknown[], TResult> {
  /** 执行操作；失败时返回 undefined（不抛出，避免未捕获的 rejection） */
  run: (...args: TArgs) => Promise<TResult | undefined>
  loading: boolean
  error: string | null
}

/**
 * 统一的「用户触发操作」包装器（bug 1）：loading → try → 成功提示 → catch（真实错误信息）→ finally 复位。
 *
 * 目的：让每次点击都有可见进度、失败不再静默。用法：
 *   const { run: importPkg, loading: importing } = useAsyncAction(doImport, { show, success: '导入成功', errorPrefix: '导入失败：' })
 *   <button disabled={importing} onClick={() => void importPkg(file)}>…</button>
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  config?: AsyncActionConfig<TResult>,
): AsyncActionResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionRef = useRef(action)
  actionRef.current = action
  const configRef = useRef(config)
  configRef.current = config

  const run = useCallback(async (...args: TArgs): Promise<TResult | undefined> => {
    setLoading(true)
    setError(null)
    try {
      const result = await actionRef.current(...args)
      const cfg = configRef.current
      if (cfg?.success) {
        const text = typeof cfg.success === 'function' ? cfg.success(result) : cfg.success
        if (text) cfg.show?.(text)
      }
      return result
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      const text = `${configRef.current?.errorPrefix ?? ''}${reason}`
      setError(text)
      configRef.current?.show?.(text, true)
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  return { run, loading, error }
}
