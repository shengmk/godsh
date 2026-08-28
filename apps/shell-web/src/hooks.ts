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
