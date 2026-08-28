import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Allocation, AvailablePlugin, ProfileView } from '../types'
import { ContextMenu, Toast, type MenuState } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

export default function AllocationsPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [available, setAvailable] = useState<Record<string, AvailablePlugin[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 正在拖拽的分配关系（卡片）
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [draggedFrom, setDraggedFrom] = useState<string | null>(null)
  // 正在拖拽的「可用插件」（拖入环境面板即新建分配）
  const [draggedAvailable, setDraggedAvailable] = useState<{ pluginId: string; source: string } | null>(null)
  const [dragOverProfile, setDragOverProfile] = useState<string | null>(null)
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

  // profile → 已安装但未分配的插件（拖拽添加用）
  const addable = useMemo(() => {
    const m: Record<string, AvailablePlugin[]> = {}
    for (const [profile, items] of Object.entries(available)) {
      m[profile] = items.filter((i) => !i.allocated)
    }
    return m
  }, [available])

  function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // 同一 Profile 内排序
  async function handleDropOnCard(profile: string, targetId: string) {
    if (!draggedId || draggedId === targetId || draggedFrom !== profile) return
    const list = byProfile[profile] ?? []
    const ids = list.map((a) => a.id)
    const from = ids.indexOf(draggedId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(from, 1)
    ids.splice(to, 0, draggedId)
    setAllocations((prev) => {
      const byId = new Map(prev.map((a) => [a.id, a]))
      const reordered = ids
        .map((id, i) => {
          const a = byId.get(id)
          return a ? { ...a, order: i } : null
        })
        .filter((a): a is Allocation => a !== null)
      return [...prev.filter((a) => a.profile !== profile), ...reordered]
    })
    try {
      await api.reorderAllocations(profile, ids)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      await load()
    }
  }

  // 拖到 Profile 面板：可用插件 → 新建分配；已分配插件 → 跨 Profile 移动
  async function handleDropOnProfile(profile: string) {
    if (draggedAvailable) {
      const { pluginId, source } = draggedAvailable
      try {
        await api.allocate(profile, pluginId, pluginId, true)
        show(`已分配 ${pluginId}（${source === 'bundle' ? 'bundle' : '依赖'}）→ ${profile}`)
        await load()
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        await load()
      }
      return
    }
    if (!draggedId || !draggedFrom || draggedFrom === profile) return
    try {
      const moved = await api.moveAllocation(draggedId, profile)
      show(`已把 ${moved.pluginId} 移动到 ${profile}`)
      await load()
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

  function onContext(a: Allocation, e: React.MouseEvent) {
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
          {t('page.allocations.desc')} · 变更自动写回 cordis.patch.yml · 已安装插件可直接拖入面板完成分配
        </p>
      </div>

      <div className="toolbar">
        <span className="muted">
          共 {profiles.length} 个环境 · {totalAllocated} 条分配
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          💡 可用插件（已安装依赖 + bundles）可直接拖拽到任意环境面板完成分配
        </span>
        <button className="btn sm" onClick={() => load()}>
          刷新
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="empty">未发现任何 Profile</div>
      ) : (
        profiles.map((p) => {
          const list = byProfile[p.name] ?? []
          const addList = addable[p.name] ?? []
          const isOpen = expanded.has(p.name)
          const isOver = dragOverProfile === p.name
          return (
            <div
              className={`card${isOver ? ' drop-target' : ''}`}
              key={p.name}
              style={{ marginBottom: 12 }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverProfile(p.name)
              }}
              onDragLeave={() => setDragOverProfile((prev) => (prev === p.name ? null : prev))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverProfile(null)
                void handleDropOnProfile(p.name)
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
                <span className="badge">{list.length} 条分配</span>
                {addList.length > 0 && <span className="badge">{addList.length} 个可添加</span>}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.exists ? `${p.bundles.length} bundle · ${Object.keys(p.dependencies).length} 依赖` : '（目录缺失）'}
                </span>
              </div>

              {isOpen && (
                <div style={{ marginTop: 12 }}>
                  {list.length === 0 && <p className="muted" style={{ marginBottom: 8 }}>暂无分配。可从下方「可用插件」拖入或点选添加。</p>}
                  <div className="grid">
                    {list.map((a) => {
                      const idx = list.findIndex((x) => x.id === a.id)
                      return (
                        <div
                          className={`card${draggedId === a.id ? ' dragging' : ''}`}
                          key={a.id}
                          draggable
                          onDragStart={(e) => {
                            setDraggedId(a.id)
                            setDraggedFrom(a.profile)
                            setDraggedAvailable(null)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault()
                            void handleDropOnCard(a.profile, a.id)
                          }}
                          onDragEnd={() => {
                            setDraggedId(null)
                            setDraggedFrom(null)
                          }}
                          onContextMenu={(e) => onContext(a, e)}
                        >
                          <div className="card-title">
                            <span className="drag-grip" title="拖拽排序 / 拖到其它环境">⠿</span>
                            <span style={{ fontFamily: 'Consolas, monospace' }}>{a.pluginId}</span>
                            <span className={`badge ${a.enabled ? 'enabled' : 'disabled'}`}>{a.enabled ? '启用' : '禁用'}</span>
                          </div>
                          {a.pluginName && a.pluginName !== a.pluginId && <p className="card-sub">{a.pluginName}</p>}
                          <div className="row">
                            <button className="btn sm" onClick={() => toggle(a)}>
                              {a.enabled ? '禁用' : '启用'}
                            </button>
                            <button className="btn sm" onClick={() => move(a, -1)} disabled={idx <= 0}>
                              ↑
                            </button>
                            <button className="btn sm" onClick={() => move(a, 1)} disabled={idx >= list.length - 1}>
                              ↓
                            </button>
                            <button className="btn danger sm" onClick={() => remove(a)}>
                              移除
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* 可用插件区：可拖拽到任意环境面板（拖入即分配），也可点选添加 */}
                  <div className="available-area">
                    <div className="row">
                      <span className="muted" style={{ fontSize: 12 }}>
                        📦 可用插件（{addList.length}）· 已安装依赖 + bundles，拖到任意环境即分配
                      </span>
                    </div>
                    {addList.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        该环境暂无未分配的已安装插件
                      </p>
                    ) : (
                      <div className="chip-list">
                        {addList.map((i) => (
                          <span
                            key={i.pluginId}
                            className={`chip draggable${draggedAvailable?.pluginId === i.pluginId ? ' dragging' : ''}`}
                            draggable
                            title={`拖到任意环境面板分配 ${i.pluginId}`}
                            onDragStart={(e) => {
                              setDraggedAvailable({ pluginId: i.pluginId, source: i.source })
                              setDraggedId(null)
                              setDraggedFrom(null)
                              e.dataTransfer.effectAllowed = 'copy'
                            }}
                            onDragEnd={() => setDraggedAvailable(null)}
                            onClick={() => void addFromInstalled(p.name, i.pluginId)}
                          >
                            {i.source === 'bundle' ? '📦' : '📥'} {i.pluginId}
                          </span>
                        ))}
                      </div>
                    )}
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
