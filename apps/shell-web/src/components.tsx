import { useEffect, useState } from 'react'

export function Toast({ text, error }: { text: string; error?: boolean }) {
  return <div className={`toast${error ? ' error' : ''}`}>{text}</div>
}

export function Loading() {
  return <div className="empty">加载中…</div>
}

export function ErrorText({ message }: { message: string }) {
  return <div className="empty">{message}</div>
}

export interface ConfirmDialogProps {
  title: string
  message: string
  danger?: boolean
  /** 需输入的文字；为空表示任意输入均可确认 */
  requireText: string
  placeholder?: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 自定义确认框：需输入指定文字才能确认（防误删等危险操作）。 */
export function ConfirmDialog({
  title,
  message,
  danger,
  requireText,
  placeholder,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [input, setInput] = useState('')
  const valid = requireText === '' || input.trim() === requireText

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-msg">{message}</p>
        <p className="modal-hint">
          请输入 <code className="modal-code">{requireText}</code> 以确认：
        </p>
        <input
          className="input modal-input"
          autoFocus
          value={input}
          placeholder={placeholder ?? requireText}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && !busy) onConfirm()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!valid || busy} onClick={onConfirm}>
            {busy ? '处理中…' : (confirmLabel ?? '确认')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** 自定义右键菜单。点击任意处 / Esc / 再次右键时关闭。 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  useEffect(() => {
    function close() {
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', close)
    document.addEventListener('contextmenu', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 防止菜单超出视口
  const left = Math.min(menu.x, window.innerWidth - 200)
  const top = Math.min(menu.y, window.innerHeight - menu.items.length * 34 - 16)

  return (
    <div className="context-menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <div className="ctx-sep" key={i} />
        ) : (
          <button
            key={i}
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              it.onClick()
              onClose()
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  )
}

/**
 * 轻量 KeepAlive 容器：
 * 将已访问过的页面常驻挂载于 DOM 中，切换页面时仅切换 display 显隐。
 * 彻底解决换页重新加载、输入框草稿丢失、更新进度窗口丢失、滚动重置等问题。
 */
export function KeepAlive({
  activeKey,
  children,
}: {
  activeKey: string
  children: Record<string, React.ReactNode>
}) {
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([activeKey]))

  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(activeKey)) return prev
      const next = new Set(prev)
      next.add(activeKey)
      return next
    })
  }, [activeKey])

  return (
    <>
      {Array.from(mounted).map((key) => {
        const child = children[key]
        if (!child) return null
        const isActive = key === activeKey
        return (
          <div
            key={key}
            data-page-container={key}
            style={{ display: isActive ? 'block' : 'none' }}
          >
            {child}
          </div>
        )
      })}
    </>
  )
}

