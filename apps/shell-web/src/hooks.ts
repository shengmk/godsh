import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastState {
  text: string
  error?: boolean
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((text: string, error = false) => {
    setToast({ text, error })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return { toast, show }
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
