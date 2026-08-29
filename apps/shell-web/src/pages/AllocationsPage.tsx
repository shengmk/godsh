import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Allocation, AvailablePlugin, ProfileView } from '../types'
import { ContextMenu, Toast, type MenuState } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

/** 统一列表条目：已分配卡片 或 可用插件 */
type ListItem =
  | { kind: 'alloc'; alloc: Allocation }
  | { kind: 'avail'; avail: AvailablePlugin }

const KEY_PREFIX_ALLOC = 'alloc:'
const KEY_PREFIX_AVAIL = 'avail:'
/** 拖拽启动阈值（px）：超过才视为拖拽，避免误触点击 */
const DRAG_THRESHOLD = 5

function itemKey(item: ListItem): string {
  // 可用插件 key 含源环境（bundle/dep），避免同名插件在多个环境时解析歧义
  return item.kind === 'alloc'
    ? `${KEY_PREFIX_ALLOC}${item.alloc.id}`
    : `${KEY_PREFIX_AVAIL}${item.avail.source === 'bundle' ? 'bundle' : 'dep'}:${item.avail.pluginId}`
}

interface DragState {
  key: string
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
  /** 当前悬停的环境面板名 */
  overProfile: string | null
  /** 当前悬停的插入目标行 key */
  overKey: string | null
}

export default function AllocationsPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [available, setAvailable] = useState<Record<string, AvailablePlugin[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<DragState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  async function load() {
    try {
      const [p, a, av] = await Promise.all([api.profiles(), api.allocations(), api.allocationsAvailable()])
      setProfiles(p)
      setAllocations(a)
      setAvailable(av)
      setExpanded((prev) => (prev.size ? prev : new Set(p.length ? [p[0]!.name] : [])))
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // profile → 按 order 排序的分配
  const byProfile = useMemo(() => {
    const m: Record<string, Allocation[]> = {}
    for (const a of allocations) {
      ;(m[a.profile] ??= []).push(a)
    }
    for (const k of Object.keys(m)) m[k]!.sort((x, y) => x.order - y.order)
    return m
  }, [allocations])

  // profile → 已安装但未分配的插件
  const addable = useMemo(() => {
    const m: Record<string, AvailablePlugin[]> = {}
    for (const [profile, items] of Object.entries(available)) {
      m[profile] = items.filter((i) => !i.allocated)
    }
    return m
  }, [available])

  // 每个环境的统一列表：已分配在前，可用插件在后
  function unifiedList(profile: string): ListItem[] {
    const allocs = byProfile[profile] ?? []
    const avails = addable[profile] ?? []
    return [
      ...allocs.map((a): ListItem => ({ kind: 'alloc', alloc: a })),
      ...avails.map((a): ListItem => ({ kind: 'avail', avail: a })),
    ]
  }

  function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** 解析拖拽源 key（可用插件 key 格式：avail:<source>:<pluginId>） */
  function parseKey(key: string): { kind: 'alloc' | 'avail'; id: string; profile: string } | null {
    if (key.startsWith(KEY_PREFIX_ALLOC)) {
      const id = key.slice(KEY_PREFIX_ALLOC.length)
      const a = allocations.find((x) => x.id === id)
      return a ? { kind: 'alloc', id, profile: a.profile } : null
    }
    if (key.startsWith(KEY_PREFIX_AVAIL)) {
      const rest = key.slice(KEY_PREFIX_AVAIL.length)
      const sep = rest.indexOf(':')
      const pluginId = sep >= 0 ? rest.slice(sep + 1) : rest
      for (const [profile, items] of Object.entries(available)) {
        if (items.some((i) => i.pluginId === pluginId && !i.allocated)) {
          return { kind: 'avail', id: pluginId, profile }
        }
      }
    }
    return null
  }

  /** 跨环境拖放 = 剪切并复制：目标环境未安装时自动安装，再从源环境移除分配。 */
  const handleCrossProfileDrop = useCallback(
    async (src: { kind: 'alloc' | 'avail'; id: string; profile: string }, targetProfile: string) => {
      try {
        const r = await api.moveWithInstall(src.id, targetProfile, src.kind === 'alloc' ? src.profile : undefined)
        if (r.ok) {
          show(`已把 ${src.id} 复制到 ${targetProfile}${r.installed ? '' : '（已自动安装）'}`)
          await load()
        }
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await load()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profiles, allocations, available],
  )

  /** 拖放统一处理：同环境排序/分配；跨环境移动/分配。 */
  const handleDrop = useCallback(
    async (profile: string, targetKey: string | null, sourceKey: string) => {
      const src = sourceKey ? parseKey(sourceKey) : null
      if (!src) return
      // 跨环境：源环境 ≠ 目标环境
      if (src.profile !== profile) {
        await handleCrossProfileDrop(src, profile)
        return
      }
      const list = unifiedList(profile)

      // 可用插件 → 拖到已分配卡片上（含末尾空白）＝ 分配并插入该位置
      if (src.kind === 'avail') {
        const availItem = list.find((i) => i.kind === 'avail' && i.avail.pluginId === src.id)
        if (!availItem || availItem.kind !== 'avail') return
        try {
          await api.allocate(profile, availItem.avail.pluginId, availItem.avail.pluginId, true)
          await load()
          show(`已分配 ${availItem.avail.pluginId} → ${profile}`)
        } catch (e) {
          show(e instanceof Error ? e.message : String(e), true)
          await load()
        }
        return
      }

      // 已分配卡片 → 排序（目标为某条目或末尾）
      const allocIds = (byProfile[profile] ?? []).map((a) => a.id)
      const from = allocIds.indexOf(src.id)
      if (from < 0) return
      let to = allocIds.length - 1 // 默认末尾
      if (targetKey) {
        const targetIdx = list.findIndex((i) => itemKey(i) === targetKey)
        if (targetIdx >= 0) {
          let allocIdx = -1
          for (let i = targetIdx; i >= 0; i--) {
            if (list[i]!.kind === 'alloc') {
              allocIdx = allocIds.indexOf((list[i] as { alloc: Allocation }).alloc.id)
              break
            }
          }
          to = allocIdx >= 0 ? allocIdx : 0
        }
      }
      if (from === to) return
      allocIds.splice(from, 1)
      allocIds.splice(to, 0, src.id)
      setAllocations((prev) => {
        const byId = new Map(prev.map((a) => [a.id, a]))
        const reordered = allocIds
          .map((id, i) => {
            const a = byId.get(id)
            return a ? { ...a, order: i } : null
          })
          .filter((a): a is Allocation => a !== null)
        return [...prev.filter((a) => a.profile !== profile), ...reordered]
      })
      try {
        await api.reorderAllocations(profile, allocIds)
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await load()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allocations, available, profiles],
  )

  // ---------- Pointer Events 拖拽引擎（绕开浏览器原生 DnD，WebView2 兼容） ----------

  const dragCancel = useCallback(() => {
    dragRef.current = null
    setDrag(null)
  }, [])

  const dragEnd = useCallback(
    async (overProfile: string | null, overKey: string | null) => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d || !d.active || !overProfile) return
      await handleDrop(overProfile, overKey, d.key)
    },
    [handleDrop],
  )

  const onRowPointerDown = useCallback((e: React.PointerEvent, key: string) => {
    // 点按按钮/链接时不启动拖拽
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('a')) return
    e.preventDefault()
    dragRef.current = { key, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, overProfile: null, overKey: null }
  }, [])

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const d = dragRef.current
      if (!d) return
      d.x = e.clientX
      d.y = e.clientY
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
        d.active = true
      }
      // 用 elementFromPoint 找当前悬停的目标（最近的 .alloc-row 或 .card 面板）
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const row = el?.closest?.('.alloc-row') as HTMLElement | null
      const panel = (row ?? el)?.closest?.('.card') as HTMLElement | null
      const profileName = panel?.querySelector('strong')?.textContent?.trim() ?? null
      d.overProfile = profileName
      d.overKey = row?.dataset?.key ?? null
      setDrag({ ...d })
      // 拖拽中禁用文本选择/光标
      document.body.style.userSelect = 'none'
    }
    function onPointerUp() {
      const d = dragRef.current
      if (!d) return
      document.body.style.userSelect = ''
      void dragEnd(d.overProfile, d.overKey)
    }
    function onPointerCancel() {
      document.body.style.userSelect = ''
      dragCancel()
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [dragEnd, dragCancel])

  // 被拖动的条目显示名（用于跟手提示）
  const dragLabel = useMemo(() => {
    if (!drag || !drag.active) return null
    const src = parseKey(drag.key)
    if (!src) return drag.key
    return src.id
  }, [drag])

  // ---------- 行内操作 ----------

  async function move(a: Allocation, delta: number) {
    const list = byProfile[a.profile] ?? []
    const ids = list.map((x) => x.id)
    const from = ids.indexOf(a.id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    const [id] = ids.splice(from, 1)
    ids.splice(to, 0, id!)
    setAllocations((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]))
      const reordered = ids
        .map((id, i) => {
          const x = byId.get(id)
          return x ? { ...x, order: i } : null
        })
        .filter((x): x is Allocation => x !== null)
      return [...prev.filter((x) => x.profile !== a.profile), ...reordered]
    })
    try {
      await api.reorderAllocations(a.profile, ids)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      await load()
    }
  }

  function onContextAlloc(a: Allocation, e: React.MouseEvent) {
    e.preventDefault()
    const list = byProfile[a.profile] ?? []
    const idx = list.findIndex((x) => x.id === a.id)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: a.enabled ? '禁用' : '启用', onClick: () => void toggle(a) },
        { label: '上移', onClick: () => void move(a, -1), disabled: idx <= 0 },
        { label: '下移', onClick: () => void move(a, 1), disabled: idx < 0 || idx >= list.length - 1 },
        { separator: true, label: '', onClick: () => {} },
        { label: '移除分配', onClick: () => void remove(a), danger: true },
        { label: '卸载插件（含依赖）', onClick: () => void uninstall(a), danger: true },
      ],
    })
  }

  function onContextAvail(item: AvailablePlugin, e: React.MouseEvent) {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: item.source === 'bundle' ? '来源：bundle' : '来源：依赖', onClick: () => {}, disabled: true },
        { label: '拖动到其它环境可转移', onClick: () => {}, disabled: true },
      ],
    })
  }

  async function toggle(a: Allocation) {
    try {
      await api.setEnabled(a.id, !a.enabled)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function remove(a: Allocation) {
    try {
      await api.removeAllocation(a.id)
      show(`已移除 ${a.pluginId}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 卸载插件：智能卸载（依赖 → pnpm remove；纯 bundle → 从 bundles 移除不再加载），并同步移除分配记录。 */
  async function uninstall(a: Allocation) {
    if (a.pluginId === '@deepseek-ai/dsh-base') {
      show('dsh-base 是核心内核 bundle，不能卸载（环境依赖它才能启动）', true)
      return
    }
    const isWebApp = a.pluginId === '@deepseek-ai/dsh-web-app'
    const hint = isWebApp
      ? '卸载 @deepseek-ai/dsh-web-app 后，该环境将失去 Web 界面（仅保留命令行能力）。确定继续？'
      : `确定从环境 ${a.profile} 卸载插件 ${a.pluginId}？`
    if (!window.confirm(hint)) return
    try {
      const r = await api.uninstallPlugin(a.profile, a.pluginId)
      if (!r.ok) {
        show(r.message || `卸载失败（${r.errorType ?? 'unknown'}）`, true)
        return
      }
      // 卸载成功后同步移除分配记录（若仍存在）
      try {
        await api.removeAllocation(a.id)
      } catch {
        /* 分配可能已被其它操作移除 */
      }
      show(`已卸载 ${a.pluginId} ← ${a.profile}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  const totalAllocated = allocations.length

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.allocations.title')}</h1>
        <p className="page-desc">
          {t('page.allocations.desc')} · 变更自动写回 cordis.patch.yml · 按住插件行可拖动排序 / 移动到其它环境
        </p>
      </div>

      <div className="toolbar">
        <span className="muted">
          共 {profiles.length} 个环境 · {totalAllocated} 条分配
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          💡 按住插件行拖到其它环境面板 = 移动分配（可用插件需目标环境已安装）；本环境内拖动 = 排序
        </span>
        <button className="btn sm" onClick={() => load()}>
          刷新
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="empty">未发现任何 Profile</div>
      ) : (
        profiles.map((p) => {
          const list = unifiedList(p.name)
          const allocCount = (byProfile[p.name] ?? []).length
          const availCount = (addable[p.name] ?? []).length
          const isOpen = expanded.has(p.name)
          const isOver = drag?.active && drag.overProfile === p.name
          return (
            <div
              className={`card${isOver ? ' drop-target' : ''}`}
              key={p.name}
              style={{ marginBottom: 12 }}
            >
              <div
                className="row"
                style={{ cursor: 'pointer', alignItems: 'center', gap: 8 }}
                onClick={() => toggleExpand(p.name)}
                title={isOpen ? '收起' : '展开'}
              >
                <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>{isOpen ? '▾' : '▸'}</span>
                <span className="dot" />
                <strong>{p.name}</strong>
                <span className={`badge ${p.running ? 'running' : 'stopped'}`}>{p.running ? '运行中' : '已停止'}</span>
                <span className="badge">{allocCount} 条分配</span>
                {availCount > 0 && <span className="badge">{availCount} 个可添加</span>}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.exists ? `${p.bundles.length} bundle · ${Object.keys(p.dependencies).length} 依赖` : '（目录缺失）'}
                </span>
              </div>

              {isOpen && (
                <div style={{ marginTop: 12 }}>
                  {list.length === 0 && (
                    <p className="muted" style={{ marginBottom: 8 }}>
                      该环境没有已安装插件。可在「插件市场」安装后再来分配。
                    </p>
                  )}

                  {/* 统一插件列表：已分配卡片 + 可用插件，全部可拖动 */}
                  <div className="alloc-list">
                    {list.map((item) => {
                      const key = itemKey(item)
                      const isAlloc = item.kind === 'alloc'
                      const a = isAlloc ? item.alloc : null
                      const av = !isAlloc ? item.avail : null
                      const isDragging = drag?.active && drag.key === key
                      const isDropLine = drag?.active && drag.overKey === key
                      return (
                        <div
                          className={`alloc-row${isDragging ? ' dragging' : ''}${isDropLine ? ' drop-line' : ''}`}
                          key={key}
                          data-key={key}
                          style={{ cursor: 'grab' }}
                          onPointerDown={(e) => onRowPointerDown(e, key)}
                          onContextMenu={(e) => (isAlloc && a ? onContextAlloc(a, e) : av ? onContextAvail(av, e) : undefined)}
                        >
                          <span className="drag-grip" title="按住拖动">⠿</span>
                          {isAlloc && a ? (
                            <>
                              <span style={{ fontFamily: 'Consolas, monospace' }}>{a.pluginId}</span>
                              <span className={`badge ${a.enabled ? 'enabled' : 'disabled'}`}>
                                {a.enabled ? '启用' : '禁用'}
                              </span>
                              <span className="spacer" />
                              <button className="btn sm" onClick={() => toggle(a)}>
                                {a.enabled ? '禁用' : '启用'}
                              </button>
                              <button className="btn sm" onClick={() => move(a, -1)} disabled={(byProfile[p.name] ?? []).findIndex((x) => x.id === a.id) <= 0}>
                                ↑
                              </button>
                              <button
                                className="btn sm"
                                onClick={() => move(a, 1)}
                                disabled={(byProfile[p.name] ?? []).findIndex((x) => x.id === a.id) >= (byProfile[p.name] ?? []).length - 1}
                              >
                                ↓
                              </button>
                              <button className="btn danger sm" onClick={() => remove(a)}>
                                移除分配
                              </button>
                              <button className="btn danger sm" title="卸载插件（含依赖）" onClick={() => uninstall(a)}>
                                卸载
                              </button>
                            </>
                          ) : av ? (
                            <>
                              <span style={{ fontFamily: 'Consolas, monospace' }}>{av.pluginId}</span>
                              <span className={`badge ${av.source === 'bundle' ? 'kind' : 'stopped'}`}>
                                {av.source === 'bundle' ? 'bundle' : '依赖'}
                              </span>
                              <span className="badge disabled">未分配 · 拖动到环境即转移</span>
                              <span className="spacer" />
                            </>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}

      {/* 跟手拖拽提示（偏移 +16/+22，避免遮挡鼠标指针） */}
      {drag && drag.active && dragLabel && (
        <div className="drag-ghost" style={{ left: drag.x + 16, top: drag.y + 22 }}>
          <span className="drag-grip">⠿</span> {dragLabel}
        </div>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
