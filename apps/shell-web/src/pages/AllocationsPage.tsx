import { useEffect, useMemo, useState } from 'react'
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

function itemKey(item: ListItem): string {
  // 可用插件 key 含源环境（bundle/dep），避免同名插件在多个环境时解析歧义
  return item.kind === 'alloc'
    ? `${KEY_PREFIX_ALLOC}${item.alloc.id}`
    : `${KEY_PREFIX_AVAIL}${item.avail.source === 'bundle' ? 'bundle' : 'dep'}:${item.avail.pluginId}`
}

export default function AllocationsPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [available, setAvailable] = useState<Record<string, AvailablePlugin[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [dragOverProfile, setDragOverProfile] = useState<string | null>(null)
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
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

  // 每个环境的统一列表：已分配在前，可用插件在后（拖拽操作由 handler 按 kind 分派）
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

  // 解析拖拽源 key（可用插件 key 格式：avail:<source>:<pluginId>）
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

  /** 跨环境拖放：已分配卡片 → moveAllocation；可用插件 → 目标已安装才分配。 */
  async function handleCrossProfileDrop(src: { kind: 'alloc' | 'avail'; id: string; profile: string }, targetProfile: string) {
    if (src.kind === 'alloc') {
      try {
        const moved = await api.moveAllocation(src.id, targetProfile)
        show(`已把 ${moved.pluginId} 从 ${src.profile} 移动到 ${targetProfile}`)
        await load()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await load()
      }
      return
    }
    // 可用插件跨环境：目标环境必须已安装该插件（dependencies ∪ bundles）
    const target = profiles.find((x) => x.name === targetProfile)
    const installed = target ? [...target.bundles, ...Object.keys(target.dependencies)] : []
    if (!installed.includes(src.id)) {
      show(`目标环境 ${targetProfile} 未安装 ${src.id}，请先在「插件市场」安装`, true)
      return
    }
    try {
      await api.allocate(targetProfile, src.id, src.id, true)
      show(`已分配 ${src.id} → ${targetProfile}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      await load()
    }
  }

  /** 拖放统一处理：同环境排序/分配；跨环境移动/分配。sourceKey 从 dataTransfer 读取，不依赖 state。 */
  async function handleDropOnList(profile: string, targetKey: string | null, sourceKey: string) {
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
      // 目标条目若为可用插件，则插入到它前面的已分配位置
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
  }

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
        { label: '移除', onClick: () => void remove(a), danger: true },
      ],
    })
  }

  function onContextAvail(profile: string, item: AvailablePlugin, e: React.MouseEvent) {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '分配到本环境', onClick: () => void addFromInstalled(profile, item.pluginId) },
        { label: item.source === 'bundle' ? '来源：bundle' : '来源：依赖', onClick: () => {}, disabled: true },
      ],
    })
  }

  async function addFromInstalled(profile: string, pluginId: string) {
    if (!pluginId) return
    try {
      await api.allocate(profile, pluginId, pluginId, true)
      show(`已分配 ${pluginId} → ${profile}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
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

  const totalAllocated = allocations.length

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.allocations.title')}</h1>
        <p className="page-desc">
          {t('page.allocations.desc')} · 变更自动写回 cordis.patch.yml · 本环境内所有插件均可拖动排序
        </p>
      </div>

      <div className="toolbar">
        <span className="muted">
          共 {profiles.length} 个环境 · {totalAllocated} 条分配
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          💡 插件可拖动：本环境内排序；拖到其它环境面板 = 移动分配（可用插件需目标环境已安装）
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
          const isOver = dragOverProfile === p.name
          return (
            <div
              className={`card${isOver ? ' drop-target' : ''}`}
              key={p.name}
              style={{ marginBottom: 12 }}
              // 本环境面板是统一的拖放目标：同环境排序 / 跨环境移动（已分配）或分配（可用插件）
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverProfile(p.name)
              }}
              onDragLeave={() => setDragOverProfile((prev) => (prev === p.name ? null : prev))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDragOverProfile(null)
                setDropTargetKey(null)
                const sourceKey = e.dataTransfer.getData('text/plain')
                void handleDropOnList(p.name, null, sourceKey)
              }}
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

                  {/* 统一插件列表：已分配卡片 + 可用插件，全部可拖拽（仅本环境内） */}
                  <div className="alloc-list">
                    {list.map((item) => {
                      const key = itemKey(item)
                      const isAlloc = item.kind === 'alloc'
                      const a = isAlloc ? item.alloc : null
                      const av = !isAlloc ? item.avail : null
                      return (
                        <div
                          className={`alloc-row${draggedKey === key ? ' dragging' : ''}${dropTargetKey === key ? ' drop-line' : ''}`}
                          key={key}
                          draggable
                          onDragStart={(e) => {
                            setDraggedKey(key)
                            // 关键修复：必须 setData，否则 Chromium/WebView2 不启动拖拽
                            e.dataTransfer.setData('text/plain', key)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setDropTargetKey(key)
                          }}
                          onDragLeave={() => setDropTargetKey((prev) => (prev === key ? null : prev))}
                          onDrop={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setDropTargetKey(null)
                            const sourceKey = e.dataTransfer.getData('text/plain')
                            void handleDropOnList(p.name, key, sourceKey)
                          }}
                          onDragEnd={() => {
                            setDraggedKey(null)
                            setDropTargetKey(null)
                          }}
                          onContextMenu={(e) => (isAlloc && a ? onContextAlloc(a, e) : av ? onContextAvail(p.name, av, e) : undefined)}
                        >
                          <span className="drag-grip" title="拖动排序">⠿</span>
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
                                移除
                              </button>
                            </>
                          ) : av ? (
                            <>
                              <span style={{ fontFamily: 'Consolas, monospace' }}>{av.pluginId}</span>
                              <span className={`badge ${av.source === 'bundle' ? 'kind' : 'stopped'}`}>
                                {av.source === 'bundle' ? 'bundle' : '依赖'}
                              </span>
                              <span className="badge disabled">未分配</span>
                              <span className="spacer" />
                              <button className="btn primary sm" onClick={() => void addFromInstalled(p.name, av.pluginId)}>
                                分配
                              </button>
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

      {toast && <Toast text={toast.text} error={toast.error} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
