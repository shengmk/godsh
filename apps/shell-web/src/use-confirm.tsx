import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from './components'

/** 一次待确认请求。message 会被原样交给 ConfirmDialog，不做任何拼接或裁剪。 */
export interface ConfirmOptions {
  /** 正文文案。原本 window.confirm 的文案一字不改地传进来（含 \n，.modal-msg 有 pre-wrap） */
  message: string
  /** 标题，不传时用统一的「请确认」 */
  title?: string
  /** 确认按钮文案，不传时用 ConfirmDialog 默认的「确认」 */
  confirmLabel?: string
  /** 危险操作，确认按钮走 danger 配色 */
  danger?: boolean
}

export interface ConfirmApi {
  /**
   * 弹出确认框并等待用户选择：确认 resolve(true)，取消 / Esc / 点击遮罩 resolve(false)。
   * 与 window.confirm 的语义一一对应，只是把阻塞式返回改成了 Promise。
   */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** 当前待决确认的对话框节点；需要在页面 JSX 里渲染一次（位置随意，overlay 是 fixed 定位） */
  dialog: ReactNode
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

/**
 * 统一确认弹窗（U5）：把散落在各页面的 `window.confirm` 收敛到自研的 <ConfirmDialog />。
 *
 * 为什么不用 ConfirmDialog 的 requireText 特性：原生 confirm 只要求点「确定」，
 * requireText 留空字符串即表示「任意输入均可确认」，按钮始终可点，
 * 这样既复用了现成组件（不改 components.tsx），又与原生交互等价 —— 不额外增加用户负担。
 *
 * 为什么用队列而不是「覆盖 / 直接拒绝」：
 * - 覆盖会丢掉先发起那次确认的 Promise（它永远不 settle，调用方的 await 会永久挂住，
 *   后续 setBusy / setActionLoading 之类的状态再也回不来）；
 * - 直接 resolve(false) 拒绝新来的请求同样危险：新请求背后的用户动作会被静默取消，
 *   在删除 / 卸载这类破坏性场景里「看起来点了没反应」比弹窗排队更糟。
 * 所以这里按 FIFO 排队：所有调用点都会拿到自己的答案，且先弹出的确认先得到回答，
 * 顺序与原生的模态阻塞行为一致。
 */
export function useConfirm(): ConfirmApi {
  const [current, setCurrent] = useState<PendingConfirm | null>(null)

  // 队列与待决项放在 ref 里：状态更新是异步的，连续两次 confirm() 若读 state 会读到同一份旧值
  const queueRef = useRef<PendingConfirm[]>([])
  const currentRef = useRef<PendingConfirm | null>(null)
  // 组件卸载后不再 setState；同时在卸载时把悬空的 Promise 收尾，避免 await 永久挂起
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      currentRef.current?.resolve(false)
      currentRef.current = null
      for (const pending of queueRef.current) pending.resolve(false)
      queueRef.current = []
    }
  }, [])

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const item: PendingConfirm = { ...options, resolve }
      if (currentRef.current) {
        queueRef.current.push(item)
        return
      }
      currentRef.current = item
      setCurrent(item)
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    const finished = currentRef.current
    if (!finished) return
    currentRef.current = null
    const next = queueRef.current.shift() ?? null
    currentRef.current = next
    if (aliveRef.current) setCurrent(next)
    // 先切换 UI 再 resolve：避免调用方在 await 之后立刻发起的第二次 confirm 与本次收尾竞争
    finished.resolve(ok)
  }, [])

  const dialog: ReactNode = current ? (
    <ConfirmDialog
      title={current.title ?? '请确认'}
      message={current.message}
      danger={current.danger}
      // 空串 = 不需要输入任何内容即可确认，对应原生 confirm 的「确定」按钮
      requireText=""
      confirmLabel={current.confirmLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null

  return { confirm, dialog }
}
