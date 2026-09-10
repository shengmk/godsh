import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ArrowDown,
  Package,
  RefreshCw,
  Trash2,
  Folder,
  Zap,
  Power,
  Play,
  Square,
  X,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Upload,
  CheckCircle2,
  AlertCircle,
  Archive,
} from 'lucide-react'
import { api } from '../api'
import type { Allocation, AvailablePlugin, MarketCategory, ProfileView, VaultPlugin } from '../types'
import { ContextMenu, EmptyState, ToastStack, type MenuState } from '../components'
import { useAsyncAction, useToast } from '../hooks'
import { useI18n } from '../i18n'
import { usePageRefresh } from '../refresh'
import { taskManager } from '../tasks'

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
  const [vaultPlugins, setVaultPlugins] = useState<VaultPlugin[]>([])
  const [vaultExpanded, setVaultExpanded] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importCategory, setImportCategory] = useState('dev')
  const [deployTargetProfile, setDeployTargetProfile] = useState<Record<string, string>>({})
  const [vaultChecking, setVaultChecking] = useState(false)
  /** 本页刷新按钮的进行中状态（页面按钮与顶栏全局刷新共用同一份 load 逻辑） */
  const [reloading, setReloading] = useState(false)
  /** 单项/单目标操作的忙碌键集合（如 update:<分配id>、drop:<环境名>），用于禁用对应控件并显示转圈 */
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())

  // 紧凑排版与框选多选状态
  const [compactMode, setCompactMode] = useState<boolean>(true)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number; profile: string } | null>(null)

  const dragRef = useRef<DragState | null>(null)
  /** 拖放处理中标记（同步判断，避免渲染延迟期间重复触发拖放） */
  const dropBusyRef = useRef(false)
  const { toasts, show } = useToast()
  const { t } = useI18n()

  /** 置位 / 复位某个操作的忙碌键 */
  const markBusy = useCallback((key: string, on: boolean) => {
    setBusyKeys((prev) => {
      if (prev.has(key) === on) return prev
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  /** 某个操作是否进行中（用于按钮 disabled 与转圈图标） */
  const isBusy = useCallback((key: string) => busyKeys.has(key), [busyKeys])

  /**
   * 用忙碌键包裹一次异步操作：执行期间对应控件禁用 + 显示转圈，结束后自动复位。
   * 异常兜底提示，避免出现未捕获的 rejection（各处理器内部原有 try/catch 的提示保持不变）。
   */
  async function withBusy<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    markBusy(key, true)
    try {
      return await action()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      return undefined
    } finally {
      markBusy(key, false)
    }
  }

  // Esc 键清空选择
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedKeys(new Set())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const loadVault = useCallback(async () => {
    try {
      const v = await api.vault()
      setVaultPlugins(v)
    } catch {}
  }, [])

  async function load() {
    setReloading(true)
    try {
      void loadVault()
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
    } finally {
      setReloading(false)
    }
  }

  /** 轻量刷新：操作后只重拉分配与可分配清单（profiles/分类几乎不变，避免重复传输）。 */
  async function refresh() {
    try {
      const [a, av] = await Promise.all([api.allocations(), api.allocationsAvailable()])
      setAllocations(a)
      setAvailable(av)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 本页刷新按钮：复用同一份 load（顶栏全局刷新也走这里） */
  async function handleReload() {
    if (reloading) return
    await load()
  }

  // 注册到全局刷新总线：顶栏刷新按钮（以及 KeepAlive 页面数据过期后重新可见）都会重新加载本页
  usePageRefresh(load, 'allocations')

  // ---------- 用户触发操作的统一包装（bug 1：可见进度 + 真实错误提示） ----------

  /** 本地插件导入（弹窗确认按钮） */
  const importLocalAction = useAsyncAction(
    async (path: string, category: string) => {
      const r = await api.vaultImportLocal(path, category)
      setImportModalOpen(false)
      setImportPath('')
      await loadVault()
      return r
    },
    { show, success: (r) => `已导入本地插件: ${r.plugin.name} (v${r.plugin.version})` },
  )

  /** 批量启用 / 禁用 */
  const batchToggleAction = useAsyncAction(
    async (ids: string[], enabled: boolean) => {
      for (const id of ids) {
        await api.setEnabled(id, enabled)
      }
      await refresh()
      return { count: ids.length, enabled }
    },
    { show, success: ({ count, enabled }) => `已批量${enabled ? '启用' : '禁用'} ${count} 个插件` },
  )

  /** 批量纳管下至仓库沙箱 */
  const batchHarvestAction = useAsyncAction(
    async (items: { profile: string; pluginId: string }[]) => {
      let count = 0
      for (const it of items) {
        await api.vaultHarvest(it.profile, it.pluginId)
        count++
      }
      await loadVault()
      setSelectedKeys(new Set())
      return { count }
    },
    { show, success: ({ count }) => `已批量纳管 ${count} 个插件下至仓库沙箱！` },
  )

  /** 批量移除分配 */
  const batchRemoveAction = useAsyncAction(
    async (allocIds: string[]) => {
      for (const id of allocIds) {
        await api.removeAllocation(id)
      }
      setSelectedKeys(new Set())
      await refresh()
      return { count: allocIds.length }
    },
    { show, success: ({ count }) => `已批量移除 ${count} 项分配` },
  )

  /** 批量转移 / 复制到目标环境 */
  const batchMoveAction = useAsyncAction(
    async (items: { id: string; profile: string }[], targetProfile: string) => {
      let moved = 0
      for (const it of items) {
        await api.moveWithInstall(it.id, targetProfile, it.profile)
        moved++
      }
      setSelectedKeys(new Set())
      await refresh()
      return { moved, targetProfile }
    },
    { show, success: ({ moved, targetProfile }) => `已成功将 ${moved} 个插件批量分发复制到环境 [${targetProfile}]` },
  )

  /** 任一批量操作进行中：禁用其它批量入口，避免并发冲突 */
  const batchBusy =
    batchToggleAction.loading || batchHarvestAction.loading || batchRemoveAction.loading || batchMoveAction.loading

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
    await withBusy(`assign:${profile}:${category}`, async () => {
      try {
        const r = await api.assignCategory(profile, category)
        show(`已分配 ${r.assigned} 个 ${zh} 插件到 ${profile}${r.skipped ? `（${r.skipped} 个已分配过）` : ''}`)
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
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
          await refresh()
        } else {
          show(`跨环境转移 ${pluginId} → ${targetProfile} 失败`, true)
        }
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await refresh()
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
          await refresh()
          show(`已分配 ${availItem.avail.pluginId} → ${profile}`)
        } catch (e) {
          show(e instanceof Error ? e.message : String(e), true)
          await refresh()
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
        await refresh()
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
      // 拖放处理中不接受新的拖放（避免并发写坏顺序），并对外暴露可见进度
      if (dropBusyRef.current) return
      dropBusyRef.current = true
      markBusy(`drop:${overProfile}`, true)
      try {
        await handleDrop(overProfile, overKey, d.key)
      } finally {
        dropBusyRef.current = false
        markBusy(`drop:${overProfile}`, false)
      }
    },
    [handleDrop, markBusy],
  )

  const onGripPointerDown = useCallback((e: React.PointerEvent, key: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropBusyRef.current) return
    dragRef.current = { key, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, overProfile: null, overKey: null }
  }, [])

  const onContainerPointerDown = useCallback((e: React.PointerEvent, profile: string) => {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, .drag-grip, .alloc-action-btn, .alloc-action-group')) return
    marqueeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      profile,
    }
  }, [])

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (marqueeRef.current) {
        marqueeRef.current.currentX = e.clientX
        marqueeRef.current.currentY = e.clientY
        setMarquee({ ...marqueeRef.current })

        const x1 = Math.min(marqueeRef.current.startX, e.clientX)
        const x2 = Math.max(marqueeRef.current.startX, e.clientX)
        const y1 = Math.min(marqueeRef.current.startY, e.clientY)
        const y2 = Math.max(marqueeRef.current.startY, e.clientY)

        if (Math.hypot(e.clientX - marqueeRef.current.startX, e.clientY - marqueeRef.current.startY) > 4) {
          const rows = document.querySelectorAll(`.alloc-row[data-profile="${marqueeRef.current.profile}"]`)
          const nextSel = new Set(e.ctrlKey || e.shiftKey ? selectedKeys : [])
          rows.forEach((row) => {
            const rect = row.getBoundingClientRect()
            const intersects = !(rect.left > x2 || rect.right < x1 || rect.top > y2 || rect.bottom < y1)
            const key = (row as HTMLElement).dataset.key
            if (key && intersects) {
              nextSel.add(key)
            }
          })
          setSelectedKeys(nextSel)
        }
        return
      }

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
      if (marqueeRef.current) {
        marqueeRef.current = null
        setMarquee(null)
      }
      const d = dragRef.current
      if (!d) return
      document.body.style.userSelect = ''
      void dragEnd(d.overProfile, d.overKey)
    }
    function onPointerCancel() {
      if (marqueeRef.current) {
        marqueeRef.current = null
        setMarquee(null)
      }
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
  }, [dragEnd, dragCancel, selectedKeys])

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
    await withBusy(`move:${a.id}`, async () => {
      try {
        await api.reorderAllocations(a.profile, ids)
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await refresh()
      }
    })
  }

  /** 单插件纳管下至沙箱 */
  async function harvestToVault(profile: string, pluginId: string) {
    await withBusy(`harvest:${profile}:${pluginId}`, async () => {
      try {
        const r = await api.vaultHarvest(profile, pluginId)
        if (r.ok) {
          show(`已成功将 ${pluginId} 纳管下至仓库沙箱！`)
          await loadVault()
        } else {
          show(r.message || '纳管下至沙箱失败', true)
        }
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  // 批量启用 / 禁用
  async function handleBatchToggle(enabled: boolean) {
    const idsToToggle: string[] = []
    for (const key of selectedKeys) {
      if (key.startsWith(KEY_PREFIX_ALLOC)) {
        idsToToggle.push(key.slice(KEY_PREFIX_ALLOC.length))
      }
    }
    if (idsToToggle.length === 0) return
    await batchToggleAction.run(idsToToggle, enabled)
  }

  // 批量下至沙箱
  async function handleBatchHarvest() {
    const itemsToHarvest: { profile: string; pluginId: string }[] = []
    for (const key of selectedKeys) {
      const item = parseKey(key)
      if (item) {
        itemsToHarvest.push({ profile: item.profile, pluginId: item.id })
      }
    }
    if (itemsToHarvest.length === 0) return
    await batchHarvestAction.run(itemsToHarvest)
  }

  // 批量移除分配
  async function handleBatchRemove() {
    const allocIds: string[] = []
    for (const key of selectedKeys) {
      if (key.startsWith(KEY_PREFIX_ALLOC)) {
        allocIds.push(key.slice(KEY_PREFIX_ALLOC.length))
      }
    }
    if (allocIds.length === 0) return
    if (!window.confirm(`确定从环境中批量移除选中的 ${allocIds.length} 项分配？`)) return
    await batchRemoveAction.run(allocIds)
  }

  // 批量转移/复制到目标 Profile
  async function handleBatchMove(targetProfile: string) {
    const items = [...selectedKeys]
      .map((k) => parseKey(k))
      .filter((x): x is { kind: 'alloc' | 'avail'; id: string; profile: string } => x !== null)
    if (items.length === 0) return
    await batchMoveAction.run(items, targetProfile)
  }

  function toggleSelectRow(key: string, e: React.MouseEvent | React.ChangeEvent) {
    e.stopPropagation()
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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
        { label: '下至沙箱', onClick: () => void harvestToVault(a.profile, a.pluginId) },
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
    await withBusy(`toggle:${a.id}`, async () => {
      try {
        await api.setEnabled(a.id, !a.enabled)
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  /** 可用插件单击分配：立即把该插件分配到本环境（写回 patch）。 */
  async function assignAvail(profile: string, pluginId: string) {
    await withBusy(`assignAvail:${profile}:${pluginId}`, async () => {
      try {
        await api.allocate(profile, pluginId, pluginId, true)
        show(`已分配 ${pluginId} → ${profile}`)
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await refresh()
      }
    })
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

  /** 官方内核 bundle：由 dsh 自动维护，禁止手动更新/卸载。 */
  const OFFICIAL_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])
  const isOfficialBundle = (id: string) => OFFICIAL_BUNDLES.has(id)

  /** 更新单个插件（分配页每行）。 */
  async function updatePlugin(a: Allocation) {
    if (isOfficialBundle(a.pluginId)) {
      show('官方内核 bundle 由 dsh 自动维护，无需手动更新', true)
      return
    }
    await withBusy(`update:${a.id}`, async () => {
      try {
        const r = await api.installPlugin(a.profile, 'update', a.pluginId)
        if (r.ok) show(`已更新 ${a.pluginId}`)
        else show(r.message || `更新失败（${r.errorType ?? 'unknown'}）`, true)
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  /** 更新某环境全部已安装插件（后台任务 + 进度面板）。 */
  const [updatingProfile, setUpdatingProfile] = useState<string | null>(null)
  const [updateLog, setUpdateLog] = useState('')
  const [updateStatus, setUpdateStatus] = useState<'running' | 'done' | 'error'>('running')

  // 监听全局任务中心，若当前环境有更新任务在跑，自动同步进度与日志到本页面板
  useEffect(() => {
    return taskManager.subscribe((tasks) => {
      if (!updatingProfile) return
      const t = tasks.find((x) => x.profile === updatingProfile && x.type === 'update-all')
      if (t) {
        setUpdateLog(t.log)
        setUpdateStatus(t.status)
      }
    })
  }, [updatingProfile])

  async function updateAll(profile: string) {
    if (updatingProfile) return show(`正在更新 ${updatingProfile}，请稍候`, true)
    if (!window.confirm(`确定更新环境 ${profile} 的全部插件？`)) return
    markBusy(`updateAll:${profile}`, true)
    setUpdatingProfile(profile)
    setUpdateLog('准备中…\n')
    setUpdateStatus('running')

    const res = await taskManager.startUpdateAllTask(profile, async (ok) => {
      show(ok ? `环境 ${profile} 插件更新完成` : `更新出错`)
      markBusy(`updateAll:${profile}`, false)
      await refresh()
    })

    if (!res.ok) {
      markBusy(`updateAll:${profile}`, false)
      setUpdatingProfile(null)
      show(res.message || '启动更新失败', true)
    }
  }

  /** 关闭本地进度面板（后台任务仍继续在全局任务中心运行）。 */
  function closeUpdatePanel() {
    setUpdatingProfile(null)
  }

  async function remove(a: Allocation) {
    await withBusy(`remove:${a.id}`, async () => {
      try {
        await api.removeAllocation(a.id)
        show(`已移除 ${a.pluginId}`)
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  /** 卸载插件：智能卸载（依赖 → pnpm remove；纯 bundle → 从 bundles 移除不再加载），并同步移除分配记录。 */
  async function uninstall(a: Allocation) {
    if (a.pluginId === '@deepseek-ai/dsh-base') {
      show('dsh-base 是核心内核 bundle，不能卸载（环境依赖它才能启动）', true)
      return
    }
    if (a.pluginId === '@deepseek-ai/dsh-headless') {
      show('dsh-headless 是官方内核 bundle，不能卸载', true)
      return
    }
    const isWebApp = a.pluginId === '@deepseek-ai/dsh-web-app'
    const hint = isWebApp
      ? '卸载 @deepseek-ai/dsh-web-app 后，该环境将失去 Web 界面（仅保留命令行能力）。确定继续？'
      : `确定从环境 ${a.profile} 卸载插件 ${a.pluginId}？`
    if (!window.confirm(hint)) return
    await withBusy(`uninstall:${a.id}`, async () => {
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
        await refresh()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  async function handleImportLocal() {
    const path = importPath.trim()
    if (!path) return
    await importLocalAction.run(path, importCategory)
  }

  async function handleDeployVault(plugin: VaultPlugin) {
    const target = deployTargetProfile[plugin.id] || profiles[0]?.name
    if (!target) {
      show('请先选择目标环境', true)
      return
    }
    await withBusy(`deploy:${plugin.id}`, async () => {
      try {
        const r = await api.vaultDeploy(plugin.id, target)
        if (r.companionAdded && r.companionAdded.length > 0) {
          show(`已秒级分发到 ${target}，并自动补齐伴随驱动: ${r.companionAdded.join(', ')}`)
        } else {
          show(`已秒级分发 ${plugin.name} 到 ${target}`)
        }
        await refresh()
        await loadVault()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  async function handleRemoveVault(id: string) {
    if (!window.confirm('确定将该插件从仓库沙箱中移除？（不影响已分配的 Profile）')) return
    await withBusy(`vaultRemove:${id}`, async () => {
      try {
        await api.vaultRemove(id)
        show('已移出沙箱')
        await loadVault()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
      }
    })
  }

  async function handleCheckVaultUpdates() {
    setVaultChecking(true)
    try {
      const r = await api.vaultCheckUpdates()
      const updated = (r.updates || []).filter((x) => x.hasUpdate).length
      if (updated > 0) {
        if (window.confirm(`已比对，发现 ${updated} 个沙箱插件有新版本更新！是否立即自动全量拉取升级并同步挂载环境？`)) {
          show(`已将沙箱全量更新任务提交至右下角任务中心...`)
          await taskManager.startVaultUpdateAllTask((ok) => {
            if (ok) {
              show(`沙箱全量自动升级完成并同步挂载环境！`)
              void refresh()
              void loadVault()
            } else {
              show(`沙箱自动升级完成（部分可能有异常），详情查看任务中心`, true)
              void refresh()
              void loadVault()
            }
          })
        } else {
          show(`发现 ${updated} 个插件有新版本`)
        }
      } else {
        show('已比对，沙箱插件均为最新版本')
      }
      await loadVault()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setVaultChecking(false)
    }
  }

  const totalAllocated = allocations.length

  /** 正在处理拖放的目标环境（用于卡片上的进度标记） */
  const dropBusyProfile = useMemo(() => {
    const hit = Array.from(busyKeys).find((k) => k.startsWith('drop:'))
    return hit ? hit.slice('drop:'.length) : null
  }, [busyKeys])
  /** 是否有拖放操作正在处理（用于全局进度提示） */
  const dropBusy = dropBusyProfile !== null

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.allocations.title')}</h1>
        <p className="page-desc">
          {t('page.allocations.desc')} · 变更自动写回 cordis.patch.yml · 可添加插件按 dshmarket 市场分类分组，一键全部分配
        </p>
      </div>

      <div className="toolbar">
        <span className="muted">
          共 {profiles.length} 个环境 · {totalAllocated} 条分配 · {categories.length} 个市场分类
        </span>
        <span className="spacer" />
        <button
          className={`btn sm ${compactMode ? 'primary' : ''}`}
          onClick={() => setCompactMode(!compactMode)}
          title="切换高密度紧凑视图或标准视图"
        >
          <SlidersHorizontal size={12} /> {compactMode ? '紧凑视图 (开)' : '舒适视图'}
        </button>
        <button className="btn sm" disabled={reloading} onClick={() => void handleReload()} title="重新加载本页数据">
          <RefreshCw size={12} className={reloading ? 'animate-spin' : ''} /> {reloading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {/* 插件仓库沙箱中枢 (Plugin Vault) */}
      <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(94, 106, 210, 0.3)' }}>
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
          onClick={() => setVaultExpanded(!vaultExpanded)}
        >
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              {vaultExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <div className="card-title" style={{ margin: 0, color: 'var(--brand-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Package size={16} />
              <span>插件仓库沙箱中枢 (Plugin Vault)</span>
            </div>
            <span className="badge info">{vaultPlugins.length} 个就绪插件</span>
            <span className="muted" style={{ fontSize: 12 }}>
              代替临时 profiles 暂存 · 启动静默差量检更 · 快速秒级流转到环境
            </span>
          </div>
          <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
            <button className="btn sm primary" onClick={() => setImportModalOpen(true)}>
              <Upload size={12} /> 导入本地插件
            </button>
            <button
              className={`btn sm ${vaultChecking ? 'loading' : ''}`}
              disabled={vaultChecking}
              onClick={() => void handleCheckVaultUpdates()}
            >
              <RefreshCw size={12} className={vaultChecking ? 'animate-spin' : ''} /> {vaultChecking ? '检测中…' : '检查沙箱更新'}
            </button>
          </div>
        </div>

        {vaultExpanded && (
          <div style={{ marginTop: 14 }}>
            {vaultPlugins.length === 0 ? (
              <EmptyState
                compact
                icon={Archive}
                title="沙箱隔离仓库中暂无插件"
                description="Vault 存储池为空。您可以从市场将插件暂存至沙箱，或导入本地开发中的插件包。"
              />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                {vaultPlugins.map((vp) => (
                  <div
                    key={vp.id}
                    className="card"
                    style={{
                      padding: 12,
                      background: 'var(--surface-soft, rgba(0,0,0,0.02))',
                      border: vp.hasUpdate ? '1px solid rgba(245, 158, 11, 0.7)' : '1px solid var(--card-border)',
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{vp.name}</span>
                      <span className="badge sm">{vp.version}</span>
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
                      <span className={`badge sm ${vp.source === 'local' ? 'warning' : 'info'}`}>
                        {vp.source === 'local' ? '本地导入' : '市场暂存'}
                      </span>
                      {vp.category && <span className="badge sm muted">{vp.category}</span>}
                      {vp.hasUpdate && (
                        <span className="badge sm warning">有新版: v{vp.latestVersion}</span>
                      )}
                    </div>
                    {vp.description && (
                      <p className="card-sub" style={{ margin: '6px 0', fontSize: 12, lineHeight: 1.4 }}>
                        {vp.description}
                      </p>
                    )}
                    <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <select
                          className="input sm"
                          style={{ padding: '2px 6px', fontSize: 12 }}
                          value={deployTargetProfile[vp.id] || profiles[0]?.name || ''}
                          disabled={isBusy(`deploy:${vp.id}`)}
                          onChange={(e) => setDeployTargetProfile({ ...deployTargetProfile, [vp.id]: e.target.value })}
                        >
                          {profiles.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn sm primary"
                          title={isBusy(`deploy:${vp.id}`) ? '分发中…' : '秒级部署至目标环境'}
                          disabled={isBusy(`deploy:${vp.id}`)}
                          onClick={() => void handleDeployVault(vp)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          {isBusy(`deploy:${vp.id}`) ? (
                            <>
                              <RefreshCw size={11} className="animate-spin" /> 分发中…
                            </>
                          ) : (
                            <>
                              <Zap size={11} /> 分发
                            </>
                          )}
                        </button>
                      </div>
                      <button
                        className="btn sm danger"
                        style={{ padding: '2px 8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        title={isBusy(`vaultRemove:${vp.id}`) ? '移出中…' : '从沙箱移出'}
                        disabled={isBusy(`vaultRemove:${vp.id}`)}
                        onClick={() => void handleRemoveVault(vp.id)}
                      >
                        {isBusy(`vaultRemove:${vp.id}`) ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 本地插件导入弹窗 */}
      {importModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setImportModalOpen(false)}
        >
          <div
            className="card"
            style={{ width: 460, maxWidth: '90vw', padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-title" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Upload size={16} /> 导入本地插件至仓库沙箱
            </div>
            <p className="card-sub" style={{ marginBottom: 14 }}>
              支持输入本地插件解压包或源码文件夹路径，系统将自动读取 package.json 并标记为就绪态。
            </p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4, fontWeight: 500 }}>
                本地目录绝对路径：
              </label>
              <input
                type="text"
                className="input"
                style={{ width: '100%' }}
                placeholder="例如: C:\Users\...\my-dsh-plugin"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4, fontWeight: 500 }}>
                选择所属分类：
              </label>
              <select
                className="input"
                style={{ width: '100%' }}
                value={importCategory}
                onChange={(e) => setImportCategory(e.target.value)}
              >
                <option value="dev">dev（开发与调试）</option>
                <option value="workflow">workflow（自动化与工作流）</option>
                <option value="tools">tools（通用工具）</option>
                <option value="agi">agi（AI 智能体）</option>
                <option value="ui">ui（界面定制）</option>
              </select>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" disabled={importLocalAction.loading} onClick={() => setImportModalOpen(false)}>
                取消
              </button>
              <button className="btn primary" disabled={importLocalAction.loading} onClick={() => void handleImportLocal()}>
                {importLocalAction.loading ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" /> 导入中…
                  </>
                ) : (
                  '确认导入'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="未发现任何 Profile 环境"
          description="当前工作空间尚未建立任何环境。请先前往「Profiles 环境」页创建环境后再来分配插件与执行管道流转。"
        />
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
                {dropBusyProfile === p.name && (
                  <span className="badge info" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <RefreshCw size={11} className="animate-spin" /> 处理中…
                  </span>
                )}
                <span className="spacer" />
                <button
                  className="btn sm"
                  title={isBusy(`updateAll:${p.name}`) ? '更新中…' : '更新该环境全部插件'}
                  disabled={isBusy(`updateAll:${p.name}`)}
                  onClick={(e) => {
                    e.stopPropagation()
                    void updateAll(p.name)
                  }}
                >
                  <RefreshCw size={12} className={isBusy(`updateAll:${p.name}`) ? 'animate-spin' : ''} />{' '}
                  {isBusy(`updateAll:${p.name}`) ? '更新中…' : '全部更新'}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.exists ? `${p.bundles.length} bundle · ${Object.keys(p.dependencies).length} 依赖` : '（目录缺失）'}
                </span>
              </div>

              {isOpen && (
                <div style={{ marginTop: 12 }}>
                  {list.length === 0 && (
                    <EmptyState
                      compact
                      icon={SlidersHorizontal}
                      title="该环境暂无已安装插件"
                      description="该 Profile 尚未安装任何插件或依赖包。您可以前往「插件市场」安装常用官方及社区插件，或从上方的沙箱仓库一键挂载。"
                    />
                  )}

                  {/* 已分配卡片（可拖动排序/转移） */}
                  {allocCount === 0 && list.length > 0 && (
                    <div className="empty-card compact" style={{ margin: '8px 0 14px 0' }}>
                      <p className="empty-title" style={{ fontSize: 13 }}>暂无已激活分配条目</p>
                      <p className="empty-desc" style={{ fontSize: 12, marginBottom: 0 }}>
                        从下方分类中勾选插件或点击「全部分配」，即可将插件加载顺序应用到当前环境。
                      </p>
                    </div>
                  )}
                  <div
                    className="alloc-list"
                    onPointerDown={(e) => onContainerPointerDown(e, p.name)}
                  >
                    {list
                      .filter((i) => i.kind === 'alloc')
                      .map((item) => {
                      const key = itemKey(item)
                      const a = item.kind === 'alloc' ? item.alloc : null
                      const isDragging = drag?.active && drag.key === key
                      const isDropLine = drag?.active && drag.overKey === key
                      const isSelected = selectedKeys.has(key)
                      // 本行各操作是否进行中（禁用对应按钮并显示转圈 / 处理中）
                      const idx = a ? (byProfile[p.name] ?? []).findIndex((x) => x.id === a.id) : -1
                      const rowMoveBusy = !!a && isBusy(`move:${a.id}`)
                      const rowToggleBusy = !!a && isBusy(`toggle:${a.id}`)
                      const rowHarvestBusy = !!a && isBusy(`harvest:${a.profile}:${a.pluginId}`)
                      const rowUpdateBusy = !!a && isBusy(`update:${a.id}`)
                      const rowRemoveBusy = !!a && isBusy(`remove:${a.id}`)
                      const rowUninstallBusy = !!a && isBusy(`uninstall:${a.id}`)
                      const rowBusy =
                        rowMoveBusy || rowToggleBusy || rowHarvestBusy || rowUpdateBusy || rowRemoveBusy || rowUninstallBusy
                      return (
                        <div
                          className={`alloc-row ${compactMode ? 'compact' : ''}${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}${isDropLine ? ' drop-line' : ''}`}
                          key={key}
                          data-key={key}
                          data-profile={p.name}
                          style={{ cursor: 'grab' }}
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
                          <input
                            type="checkbox"
                            className="alloc-checkbox"
                            checked={isSelected}
                            onChange={(e) => toggleSelectRow(key, e)}
                            onClick={(e) => e.stopPropagation()}
                            title="勾选加入多选"
                          />
                          <span
                            className="drag-grip"
                            title="按住拖动排序 / 跨环境转移"
                            onPointerDown={(e) => onGripPointerDown(e, key)}
                          >
                            ⠿
                          </span>
                          {a && (
                            <>
                              <span style={{ fontFamily: 'Consolas, monospace', fontWeight: 600, fontSize: compactMode ? '0.85rem' : '0.95rem' }}>
                                {a.pluginId}
                              </span>
                              <button
                                className={`alloc-power-btn ${a.enabled ? 'on' : 'off'}`}
                                disabled={rowToggleBusy}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void toggle(a)
                                }}
                                title={rowToggleBusy ? '处理中…' : a.enabled ? '点击禁用' : '点击启用'}
                              >
                                {rowToggleBusy ? <RefreshCw size={11} className="animate-spin" /> : <Power size={11} />}{' '}
                                {a.enabled ? '启用' : '禁用'}
                              </button>
                              {rowBusy && (
                                <span className="badge info" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <RefreshCw size={11} className="animate-spin" /> 处理中…
                                </span>
                              )}
                              <span className="spacer" />
                              <div className="alloc-action-group" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void move(a, -1)}
                                  disabled={idx <= 0 || rowMoveBusy}
                                  title={rowMoveBusy ? '处理中…' : '上移'}
                                >
                                  {rowMoveBusy ? <RefreshCw size={12} className="animate-spin" /> : <ArrowUp size={12} />}
                                </button>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void move(a, 1)}
                                  disabled={idx < 0 || idx >= (byProfile[p.name] ?? []).length - 1 || rowMoveBusy}
                                  title={rowMoveBusy ? '处理中…' : '下移'}
                                >
                                  {rowMoveBusy ? <RefreshCw size={12} className="animate-spin" /> : <ArrowDown size={12} />}
                                </button>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void harvestToVault(a.profile, a.pluginId)}
                                  disabled={rowHarvestBusy}
                                  title={rowHarvestBusy ? '纳管中…' : '纳管下至仓库沙箱 (Vault)'}
                                >
                                  {rowHarvestBusy ? (
                                    <>
                                      <RefreshCw size={12} className="animate-spin" /> 纳管中…
                                    </>
                                  ) : (
                                    <>
                                      <Package size={12} /> 沙箱
                                    </>
                                  )}
                                </button>
                                <button
                                  className="alloc-action-btn"
                                  title={rowUpdateBusy ? '更新中…' : '更新此插件'}
                                  disabled={rowUpdateBusy}
                                  onClick={() => void updatePlugin(a)}
                                >
                                  <RefreshCw size={12} className={rowUpdateBusy ? 'animate-spin' : ''} />{' '}
                                  {rowUpdateBusy ? '更新中…' : '更新'}
                                </button>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void remove(a)}
                                  disabled={rowRemoveBusy}
                                  title={rowRemoveBusy ? '移除中…' : '移除分配'}
                                >
                                  {rowRemoveBusy ? (
                                    <>
                                      <RefreshCw size={12} className="animate-spin" /> 移除中…
                                    </>
                                  ) : (
                                    <>
                                      <X size={12} /> 移除
                                    </>
                                  )}
                                </button>
                                <button
                                  className="alloc-action-btn danger"
                                  title={rowUninstallBusy ? '卸载中…' : '卸载插件（含依赖）'}
                                  disabled={rowUninstallBusy}
                                  onClick={() => void uninstall(a)}
                                >
                                  {rowUninstallBusy ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })}

                    {/* 可添加插件：按市场分类分组 */}
                    {(addableByCategory[p.name] ?? []).map((group) => {
                      const groupAssignBusy = isBusy(`assign:${p.name}:${group.category}`)
                      return (
                      <div key={group.category} className="alloc-group">
                        <div className="alloc-group-head">
                          <span className="alloc-group-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Folder size={14} style={{ color: 'var(--brand-primary)' }} />
                            <span>{group.zh}</span>
                          </span>
                          <span className="badge">{group.items.length} 个可添加</span>
                          <span className="spacer" />
                          <button
                            className="btn sm"
                            title={groupAssignBusy ? '分配中…' : `把 ${group.zh} 分类全部 ${group.items.length} 个插件分配到 ${p.name}`}
                            disabled={groupAssignBusy}
                            onClick={() => void assignCategory(p.name, group.category, group.zh)}
                          >
                            <RefreshCw size={12} className={groupAssignBusy ? 'animate-spin' : ''} />{' '}
                            {groupAssignBusy ? '分配中…' : '全部分配'}
                          </button>
                        </div>
                        {group.items.map((av) => {
                          const key = itemKey({ kind: 'avail', avail: av })
                          const isDragging = drag?.active && drag.key === key
                          const isDropLine = drag?.active && drag.overKey === key
                          const isSelected = selectedKeys.has(key)
                          const availAssignBusy = isBusy(`assignAvail:${p.name}:${av.pluginId}`)
                          const availHarvestBusy = isBusy(`harvest:${p.name}:${av.pluginId}`)
                          return (
                            <div
                              className={`alloc-row ${compactMode ? 'compact' : ''}${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}${isDropLine ? ' drop-line' : ''}`}
                              key={key}
                              data-key={key}
                              data-profile={p.name}
                              style={{ cursor: 'pointer' }}
                              onMouseEnter={(e) => {
                                showTooltip(e, av.pluginId, {
                                  desc: av.description,
                                  version: av.version,
                                  source: av.source === 'bundle' ? 'bundle' : '依赖',
                                });
                              }}
                              onMouseLeave={hideTooltip}
                              onClick={(e) => {
                                if (!drag?.active && !e.defaultPrevented && !availAssignBusy) void assignAvail(p.name, av.pluginId)
                              }}
                              onContextMenu={(e) => onContextAvail(av, e)}
                            >
                              <input
                                type="checkbox"
                                className="alloc-checkbox"
                                checked={isSelected}
                                onChange={(e) => toggleSelectRow(key, e)}
                                onClick={(e) => e.stopPropagation()}
                                title="勾选加入多选"
                              />
                              <span
                                className="drag-grip"
                                title="按住拖动转移"
                                onPointerDown={(e) => onGripPointerDown(e, key)}
                              >
                                ⠿
                              </span>
                              <span style={{ fontFamily: 'Consolas, monospace', fontWeight: 600, fontSize: compactMode ? '0.85rem' : '0.95rem' }}>
                                {av.pluginId}
                              </span>
                              <span className={`badge ${av.source === 'bundle' ? 'kind' : 'stopped'}`}>
                                {av.source === 'bundle' ? 'bundle' : '依赖'}
                              </span>
                              <span className="badge disabled">未分配 · 单击分配 / 拖动转移</span>
                              {(availAssignBusy || availHarvestBusy) && (
                                <span className="badge info" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <RefreshCw size={11} className="animate-spin" /> {availAssignBusy ? '分配中…' : '纳管中…'}
                                </span>
                              )}
                              <span className="spacer" />
                              <div className="alloc-action-group" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void assignAvail(p.name, av.pluginId)}
                                  disabled={availAssignBusy}
                                  title={availAssignBusy ? '分配中…' : '分配至当前环境'}
                                >
                                  {availAssignBusy ? (
                                    <>
                                      <RefreshCw size={12} className="animate-spin" /> 分配中…
                                    </>
                                  ) : (
                                    <>
                                      <Zap size={12} /> 分配
                                    </>
                                  )}
                                </button>
                                <button
                                  className="alloc-action-btn"
                                  onClick={() => void harvestToVault(p.name, av.pluginId)}
                                  disabled={availHarvestBusy}
                                  title={availHarvestBusy ? '纳管中…' : '纳管下至仓库沙箱 (Vault)'}
                                >
                                  {availHarvestBusy ? (
                                    <>
                                      <RefreshCw size={12} className="animate-spin" /> 纳管中…
                                    </>
                                  ) : (
                                    <>
                                      <Package size={12} /> 下至沙箱
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          )
                        })}
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

      {/* 浮动批量控制中枢 */}
      {selectedKeys.size > 0 && (
        <div className="batch-floating-bar">
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
            已选择 <strong>{selectedKeys.size}</strong> 项插件
          </span>
          <button className="btn sm" disabled={batchBusy} onClick={() => void handleBatchToggle(true)}>
            {batchToggleAction.loading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 处理中…
              </>
            ) : (
              <>
                <Play size={12} /> 批量启用
              </>
            )}
          </button>
          <button className="btn sm" disabled={batchBusy} onClick={() => void handleBatchToggle(false)}>
            {batchToggleAction.loading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 处理中…
              </>
            ) : (
              <>
                <Square size={12} /> 批量禁用
              </>
            )}
          </button>
          <button
            className="btn sm"
            style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--brand-text)', borderColor: 'var(--brand-text)', fontWeight: 600 }}
            disabled={batchBusy}
            onClick={() => void handleBatchHarvest()}
          >
            {batchHarvestAction.loading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 纳管中…
              </>
            ) : (
              <>
                <Package size={12} /> 批量下至沙箱
              </>
            )}
          </button>
          <button className="btn sm danger" disabled={batchBusy} onClick={() => void handleBatchRemove()}>
            {batchRemoveAction.loading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 移除中…
              </>
            ) : (
              <>
                <Trash2 size={12} /> 批量移除
              </>
            )}
          </button>
          {profiles.length > 1 && (
            <select
              className="input sm"
              defaultValue=""
              disabled={batchBusy}
              onChange={(e) => {
                if (e.target.value) {
                  void handleBatchMove(e.target.value)
                  e.target.value = ''
                }
              }}
              style={{ width: '130px', padding: '2px 6px' }}
            >
              <option value="" disabled>
                {batchMoveAction.loading ? '转移中…' : '批量转移到…'}
              </option>
              {profiles.map((pr) => (
                <option key={pr.name} value={pr.name}>
                  → {pr.name}
                </option>
              ))}
            </select>
          )}
          {batchMoveAction.loading && (
            <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}>
              <RefreshCw size={12} className="animate-spin" /> 转移中…
            </span>
          )}
          <button className="btn sm subtle" onClick={() => setSelectedKeys(new Set())} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <X size={12} /> 取消选择 (Esc)
          </button>
        </div>
      )}

      {/* 拖放处理中：全局进度提示（有批量栏时上移，避免遮挡） */}
      {dropBusy && (
        <div className="batch-floating-bar" style={{ bottom: selectedKeys.size > 0 ? 84 : 24 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', fontWeight: 600 }}>
            <RefreshCw size={12} className="animate-spin" /> 正在处理拖放操作…
          </span>
        </div>
      )}

      {/* 鼠标框选多选框 */}
      {marquee && (
        <div
          className="marquee-selection-box"
          style={{
            left: Math.min(marquee.startX, marquee.currentX),
            top: Math.min(marquee.startY, marquee.currentY),
            width: Math.abs(marquee.currentX - marquee.startX),
            height: Math.abs(marquee.currentY - marquee.startY),
          }}
        />
      )}

      {/* 全部更新进度面板 */}
      {updatingProfile && (
        <div className="progress-panel">
          <div className="progress-head">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={13} className="animate-spin" /> 正在更新环境 {updatingProfile}
            </span>
            <button className="btn sm" onClick={closeUpdatePanel} title="关闭" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={12} />
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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={13} className="animate-spin" /> 更新中…
              </span>
            ) : updateStatus === 'done' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--success)' }}>
                <CheckCircle2 size={13} /> 全部完成
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--err)' }}>
                <AlertCircle size={13} /> 更新出错
              </span>
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

      <ToastStack toasts={toasts} />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
