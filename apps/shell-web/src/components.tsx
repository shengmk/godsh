import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, type LucideIcon } from 'lucide-react'

export function Toast({ text, error }: { text: string; error?: boolean }) {
  return <div className={`toast${error ? ' error' : ''}`}>{text}</div>
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="loading-state-wrap">
      <div className="loading-spinner-ring" />
      <span className="loading-text">{label ?? '正在同步加载数据…'}</span>
    </div>
  )
}

export function ErrorText({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner-card">
      <AlertTriangle size={15} className="error-icon" />
      <span className="error-message">{message}</span>
      {onRetry && (
        <button className="btn sm" onClick={onRetry} style={{ marginLeft: 'auto' }}>
          <RotateCcw size={12} />
          <span>重试</span>
        </button>
      )}
    </div>
  )
}

export interface SkeletonBoxProps {
  width?: string | number
  height?: string | number
  borderRadius?: string | number
  className?: string
  style?: React.CSSProperties
}

export function SkeletonBox({
  width = '100%',
  height = 16,
  borderRadius = 'var(--radius-sm, 6px)',
  className = '',
  style,
}: SkeletonBoxProps) {
  return (
    <div
      className={`skeleton-shimmer ${className}`.trim()}
      style={{
        width,
        height,
        borderRadius,
        ...style,
      }}
    />
  )
}

export function SkeletonCard() {
  return (
    <div className="card skeleton-card-wrap">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <SkeletonBox width={20} height={20} borderRadius="50%" />
        <SkeletonBox width="45%" height={18} />
        <span style={{ marginLeft: 'auto' }}>
          <SkeletonBox width={54} height={20} borderRadius={999} />
        </span>
      </div>
      <SkeletonBox width="80%" height={14} style={{ marginBottom: 8 }} />
      <SkeletonBox width="60%" height={12} style={{ marginBottom: 16 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <SkeletonBox width={72} height={28} borderRadius={6} />
        <SkeletonBox width={72} height={28} borderRadius={6} />
        <SkeletonBox width={32} height={28} borderRadius={6} style={{ marginLeft: 'auto' }} />
      </div>
    </div>
  )
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

export function SkeletonTable({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="skeleton-table-row">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBox
              key={c}
              width={c === 0 ? '30%' : c === cols - 1 ? '15%' : '20%'}
              height={16}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <div style={{ marginBottom: 20 }}>
        <SkeletonBox width={180} height={24} style={{ marginBottom: 8 }} />
        <SkeletonBox width={320} height={14} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <SkeletonBox width={220} height={32} />
        <SkeletonBox width={90} height={32} />
        <SkeletonBox width={90} height={32} />
      </div>
      <SkeletonGrid count={6} />
    </div>
  )
}

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: {
    label: string
    icon?: LucideIcon
    onClick: () => void
    variant?: 'primary' | 'secondary' | 'glow'
    danger?: boolean
  }
  secondaryAction?: {
    label: string
    icon?: LucideIcon
    onClick: () => void
  }
  children?: ReactNode
  compact?: boolean
  className?: string
  style?: React.CSSProperties
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  compact = false,
  className = '',
  style,
}: EmptyStateProps) {
  return (
    <div className={`empty-card${compact ? ' compact' : ''} ${className}`.trim()} style={style}>
      {Icon && (
        <div className="empty-icon-halo">
          <Icon size={compact ? 22 : 28} />
        </div>
      )}
      <h4 className="empty-title">{title}</h4>
      {description && <p className="empty-desc">{description}</p>}
      {children}
      {(action || secondaryAction) && (
        <div className="empty-actions">
          {action && (
            <button
              className={`btn ${action.variant === 'glow' ? 'btn-glow-primary' : action.variant === 'secondary' ? '' : action.danger ? 'danger' : 'primary'}`}
              onClick={action.onClick}
            >
              {action.icon && <action.icon size={13} />}
              <span>{action.label}</span>
            </button>
          )}
          {secondaryAction && (
            <button className="btn" onClick={secondaryAction.onClick}>
              {secondaryAction.icon && <secondaryAction.icon size={13} />}
              <span>{secondaryAction.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export interface ErrorBoundaryProps {
  children: ReactNode
  fallbackTitle?: string
  onReset?: () => void
}

export interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })
    console.error('[godsh ErrorBoundary]', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onReset?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fault-card">
          <div className="fault-icon-halo">
            <AlertTriangle size={28} />
          </div>
          <h3 className="fault-title">{this.props.fallbackTitle ?? '模块运行发生异常 (Runtime Exception)'}</h3>
          <p className="fault-desc">
            数据解析或交互处理遇到未捕获异常。系统已限制异常扩散并开启自愈沙箱保护，杜绝白屏闪退。
          </p>
          <div className="fault-details">
            <code className="fault-code">{this.state.error?.message || '未知异常'}</code>
          </div>
          <div className="fault-actions">
            <button className="btn primary" onClick={this.handleRetry}>
              <RotateCcw size={13} />
              <span>重试该模块</span>
            </button>
            <button
              className="btn"
              onClick={() => {
                window.location.hash = '#console'
                this.setState({ hasError: false, error: null, errorInfo: null })
              }}
            >
              <span>返回控制台</span>
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              <span>刷新界面</span>
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
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

