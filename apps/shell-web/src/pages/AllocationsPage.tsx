import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Allocation, AvailablePlugin, MarketCategory, ProfileView } from '../types'
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
  const [categories, setCategories] = useState<MarketCategory[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<DragState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  async function load() {
    try {
      const [p, a, av, cats] = await Promise.all([
        api.profiles(),
        api.allocations(),
        api.allocationsAvailable(),
        api.marketCategories().catch(() => []),
      ])
      setProfiles(p)
      setAllocations(a)
      setAvailable(av)
      setCategories(cats)
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

  // 分类中文名（市场分类表；未知分类回退英文名）
  const categoryZh = useCallback(
    (c: string | undefined) => {
      if (!c) return '未分类'
      return categories.find((x) => x.category === c)?.zh ?? c
    },
    [categories],
  )

  // profile → 未分配插件按市场分类分组（无分类归入 "未分类"）
  const addableByCategory = useMemo(() => {
    const m: Record<string, { category: string; zh: string; items: AvailablePlugin[] }[]> = {}
    for (const [profile, items] of Object.entries(addable)) {
      const groups = new Map<string, AvailablePlugin[]>()
      for (const it of items) {
        const c = it.category || '未分类'
        if (!groups.has(c)) groups.set(c, [])
        groups.get(c)!.push(it)
      }
      m[profile] = [...groups.entries()]
        .map(([category, groupItems]) => ({ category, zh: categoryZh(category), items: groupItems }))
        .sort((a, b) => b.items.length - a.items.length)
    }
    return m
  }, [addable, categoryZh])

  /** 一键分配某环境某分类的全部未分配插件。 */
  async function assignCategory(profile: string, category: string, zh: string) {
    const count = (addableByCategory[profile] ?? []).find((g) => g.category === category)?.items.length ?? 0
    if (count === 0) return
    if (!window.confirm(`确定把 ${zh}（${count} 个）全部分配到环境 ${profile}？`)) return
    try {
      const r = await api.assignCategory(profile, category)
      show(`已分配 ${r.assigned} 个 ${zh} 插件到 ${profile}${r.skipped ? `（${r.skipped} 个已分配过）` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

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
      // src.id 对 alloc 是分配记录 id，需要解析出真实 pluginId
      let pluginId = src.id
      let fromProfile: string | undefined
      if (src.kind === 'alloc') {
        const a = allocations.find((x) => x.id === src.id)
        if (!a) {
          show('未找到该分配记录', true)
          return
        }
        pluginId = a.pluginId
        fromProfile = a.profile
      }
      try {
        const r = await api.moveWithInstall(pluginId, targetProfile, fromProfile)
        if (r.ok) {
          show(`已把 ${pluginId} 复制到 ${targetProfile}${r.installed ? '' : '（已自动安装）'}`)
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
      const panel = (row ?? el)?.closest?.('.card[data-profile]') as HTMLElement | null
      const profileName = panel?.dataset?.profile ?? panel?.querySelector('strong')?.textContent?.trim() ?? null
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
        { label: '更新', onClick: () => void updatePlugin(a) },
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

  /** 可用插件单击分配：立即把该插件分配到本环境（写回 patch）。 */
  async function assignAvail(profile: string, pluginId: string) {
    try {
      await api.allocate(profile, pluginId, pluginId, true)
      show(`已分配 ${pluginId} → ${profile}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      await load()
    }
  }

  // ---------- 插件悬停简介 tooltip ----------
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; desc?: string; version?: string; source?: string } | null>(null)
  const tooltipRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTooltip = (e: React.MouseEvent, title: string, info: { desc?: string; version?: string; source?: string }) => {
    if (tooltipRef.current) clearTimeout(tooltipRef.current)
    tooltipRef.current = setTimeout(() => {
      setTooltip({ x: e.clientX + 14, y: e.clientY + 18, title, ...info })
    }, 350)
  }
  const hideTooltip = () => {
    if (tooltipRef.current) clearTimeout(tooltipRef.current)
    setTooltip(null)
  }

  /** 更新单个插件（分配页每行）。 */
  async function updatePlugin(a: Allocation) {
    if (a.pluginId === '@deepseek-ai/dsh-base' || a.pluginId === '@deepseek-ai/dsh-web-app') {
      show('官方内核 bundle 由 dsh 自动维护，无需手动更新', true)
      return
    }
    try {
      const r = await api.installPlugin(a.profile, 'update', a.pluginId)
      if (r.ok) show(`已更新 ${a.pluginId}`)
      else show(r.message || `更新失败（${r.errorType ?? 'unknown'}）`, true)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 更新某环境全部已安装插件（后台任务 + 进度面板）。 */
  const [updatingProfile, setUpdatingProfile] = useState<string | null>(null)
  const [updateLog, setUpdateLog] = useState('')
  const [updateStatus, setUpdateStatus] = useState<'running' | 'done' | 'error'>('running')
  const updatePoll = useRef<ReturnType<typeof setInterval> | null>(null)
  const updateTask = useRef<string | null>(null)

  async function updateAll(profile: string) {
    if (updatingProfile) return show(`正在更新 ${updatingProfile}，请稍候`, true)
    if (!window.confirm(`确定更新环境 ${profile} 的全部插件？`)) return
    try {
      const r = await api.updateAllPlugins(profile)
      if (!r.task) {
        show(r.message || '没有可更新的插件')
        return
      }
      updateTask.current = r.task
      setUpdatingProfile(profile)
      setUpdateLog('')
      setUpdateStatus('running')
      if (updatePoll.current) clearInterval(updatePoll.current)
      updatePoll.current = setInterval(async () => {
        if (!updateTask.current) return
        try {
          const p = await api.updateAllProgress(profile, updateTask.current)
          setUpdateLog(p.log)
          if (p.status !== 'running') {
            setUpdateStatus(p.status as 'done' | 'error')
            if (updatePoll.current) clearInterval(updatePoll.current)
            updatePoll.current = null
            updateTask.current = null
            show(p.status === 'done' ? `环境 ${profile} 插件更新完成` : `更新出错：${p.message || ''}`)
            await load()
          }
        } catch {
          /* 轮询失败继续 */
        }
      }, 1500)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 关闭进度面板。 */
  function closeUpdatePanel() {
    if (updatePoll.current) clearInterval(updatePoll.current)
    updatePoll.current = null
    updateTask.current = null
    setUpdatingProfile(null)
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
          {t('page.allocations.desc')} · 变更自动写回 cordis.patch.yml · 可添加插件按 dshmarket 市场分类分组，⚡ 一键全部分配
        </p>
      </div>

      <div className="toolbar">
        <span className="muted">
          共 {profiles.length} 个环境 · {totalAllocated} 条分配 · {categories.length} 个市场分类
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          💡 拖动插件到其它环境 = 剪切并复制（自动安装到目标环境）；本环境内拖动 = 排序；⚡ 全部分配 = 按市场分类批量分配
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
              data-profile={p.name}
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
                <button
                  className="btn sm"
                  title="更新该环境全部插件"
                  onClick={(e) => {
                    e.stopPropagation()
                    void updateAll(p.name)
                  }}
                >
                  🔄 全部更新
                </button>
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

                  {/* 已分配卡片（可拖动排序/转移） */}
                  <div className="alloc-list">
                    {list
                      .filter((i) => i.kind === 'alloc')
                      .map((item) => {
                      const key = itemKey(item)
                      const a = item.kind === 'alloc' ? item.alloc : null
                      const isDragging = drag?.active && drag.key === key
                      const isDropLine = drag?.active && drag.overKey === key
                      return (
                        <div
                          className={`alloc-row${isDragging ? ' dragging' : ''}${isDropLine ? ' drop-line' : ''}`}
                          key={key}
                          data-key={key}
                          style={{ cursor: 'grab' }}
                          onPointerDown={(e) => onRowPointerDown(e, key)}
                          onMouseEnter={(e) => {
                            const title = a ? a.pluginId : ''
                            // 描述：已分配卡片从同环境 available 列表按 pluginId 匹配
                            const descInfo = (() => {
                              const match = (available[p.name] ?? []).find((x) => x.pluginId === title)
                              return match ? { desc: match.description, version: match.version, source: match.source === 'bundle' ? 'bundle' : '依赖' } : {}
                            })()
                            if (title) showTooltip(e, title, descInfo)
                          }}
                          onMouseLeave={hideTooltip}
                          onContextMenu={(e) => (a ? onContextAlloc(a, e) : undefined)}
                        >
                          <span className="drag-grip" title="按住拖动">⠿</span>
                          {a && (
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
                              <button className="btn sm" title="更新此插件" onClick={() => updatePlugin(a)}>
                                更新
                              </button>
                              <button className="btn danger sm" onClick={() => remove(a)}>
                                移除分配
                              </button>
                              <button className="btn danger sm" title="卸载插件（含依赖）" onClick={() => uninstall(a)}>
                                卸载
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })}

                    {/* 可添加插件：按市场分类分组 */}
                    {(addableByCategory[p.name] ?? []).map((group) => (
                      <div key={group.category} className="alloc-group">
                        <div className="alloc-group-head">
                          <span className="alloc-group-title">📂 {group.zh}</span>
                          <span className="badge">{group.items.length} 个可添加</span>
                          <span className="spacer" />
                          <button
                            className="btn sm"
                            title={`把 ${group.zh} 分类全部 ${group.items.length} 个插件分配到 ${p.name}`}
                            onClick={() => void assignCategory(p.name, group.category, group.zh)}
                          >
                            ⚡ 全部分配
                          </button>
                        </div>
                        {group.items.map((av) => {
                          const key = itemKey({ kind: 'avail', avail: av })
                          const isDragging = drag?.active && drag.key === key
                          const isDropLine = drag?.active && drag.overKey === key
                          return (
                            <div
                              className={`alloc-row${isDragging ? ' dragging' : ''}${isDropLine ? ' drop-line' : ''}`}
                              key={key}
                              data-key={key}
                              style={{ cursor: 'pointer' }}
                              onPointerDown={(e) => onRowPointerDown(e, key)}
                              onMouseEnter={(e) => {
                                showTooltip(e, av.pluginId, {
                                  desc: av.description,
                                  version: av.version,
                                  source: av.source === 'bundle' ? 'bundle' : '依赖',
                                })
                              }}
                              onMouseLeave={hideTooltip}
                              onClick={(e) => {
                                if (!drag?.active && !e.defaultPrevented) void assignAvail(p.name, av.pluginId)
                              }}
                              onContextMenu={(e) => onContextAvail(av, e)}
                            >
                              <span className="drag-grip" title="按住拖动">⠿</span>
                              <span style={{ fontFamily: 'Consolas, monospace' }}>{av.pluginId}</span>
                              <span className={`badge ${av.source === 'bundle' ? 'kind' : 'stopped'}`}>
                                {av.source === 'bundle' ? 'bundle' : '依赖'}
                              </span>
                              <span className="badge disabled">未分配 · 单击分配 / 拖动转移</span>
                              <span className="spacer" />
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}

      {/* 全部更新进度面板 */}
      {updatingProfile && (
        <div className="progress-panel">
          <div className="progress-head">
            <span>🔄 正在更新环境 {updatingProfile}</span>
            <button className="btn sm" onClick={closeUpdatePanel} title="关闭">
              ✕
            </button>
          </div>
          <div className="progress-bar">
            <div
              className={`progress-fill ${updateStatus}`}
              style={{ width: updateStatus === 'running' ? '45%' : updateStatus === 'done' ? '100%' : '100%' }}
            />
          </div>
          <div className="progress-status">
            {updateStatus === 'running' ? (
              <>
                <span className="splash-spinner">🌀</span> 更新中…
              </>
            ) : updateStatus === 'done' ? (
              '✅ 全部完成'
            ) : (
              '❌ 更新出错'
            )}
          </div>
          <pre className="progress-log">{updateLog || '准备中…'}</pre>
        </div>
      )}

      {/* 插件悬停简介 tooltip */}
      {tooltip && (
        <div className="plugin-tip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="plugin-tip-title">
            {tooltip.title}
            {tooltip.version ? <span className="badge kind">v{tooltip.version}</span> : null}
            {tooltip.source ? <span className={`badge ${tooltip.source === 'bundle' ? 'kind' : 'stopped'}`}>{tooltip.source}</span> : null}
          </div>
          {tooltip.desc ? <div className="plugin-tip-desc">{tooltip.desc}</div> : <div className="plugin-tip-desc muted">（暂无简介）</div>}
        </div>
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
