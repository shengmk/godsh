import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { MarketPlugin, ProfileView } from '../types'
import { ErrorText, Loading, Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

function desc(p: MarketPlugin): string {
  const d = p.description
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    // 优先中文（zh / zh-CN），其次英文
    for (const k of ['zh', 'zh-CN', 'zh_CN', 'en', 'description', 'summary']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return ''
}

const CATEGORY_LABEL: Record<string, string> = {
  fun: '趣味',
  utility: '工具',
  productivity: '效率',
  memory: '记忆',
  session: '会话',
  agent: '智能体',
  tool: '工具',
  web: '网页',
  search: '搜索',
  vision: '视觉',
  image: '图像',
  dev: '开发',
  git: 'Git',
  security: '安全',
  notify: '通知',
  im: '消息',
  music: '音乐',
  game: '游戏',
  skin: '皮肤',
  market: '市场',
  misc: '其他',
}

function categoryLabel(p: MarketPlugin): string {
  const c = p.category as string | undefined
  if (!c) return ''
  return CATEGORY_LABEL[c] ?? c
}

function fmtCount(n: unknown): string {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return ''
  if (num >= 10000) return `${(num / 10000).toFixed(1)}w`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`
  return String(num)
}

const ERROR_TYPE_LABEL: Record<string, string> = {
  network: '网络错误',
  'not-found': '包不存在',
  auth: '权限/源拒绝',
  version: '版本不匹配',
  deps: '依赖冲突',
  timeout: '安装超时',
  policy: '来源策略拒绝',
  'not-installed': '非独立依赖',
  protected: '受保护的内核',
  'release-age': '发布年龄限制',
  other: '安装失败',
}

function errorLabel(r: { errorType?: string; message?: string; stderr?: string }): string {
  const type = r.errorType ?? 'other'
  const label = ERROR_TYPE_LABEL[type] ?? '安装失败'
  const msg = r.message || r.stderr || ''
  return msg ? `${label}：${msg}` : label
}

/**
 * 真实安装包名：市场索引的 `name`（展示名）≠ npm 包名。
 * 例如 name='dsh-memory'，npm='@furongjun1999/dsh-memory'——必须用 npm 字段才能装。
 * 返回 p.npm（真实包名）优先，无 npm 字段时回退 name（部分插件 npm 字段为空，可能是同名词或需 tarball）。
 */
function pkgName(p: MarketPlugin): string {
  if (typeof p.npm === 'string' && p.npm.trim()) return p.npm.trim()
  return p.name
}

type SortBy = 'default' | 'hot' | 'latest'

interface QueueItem {
  pkg: string
  status: 'pending' | 'installing' | 'done' | 'error'
  error?: string
}

export default function MarketPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [profile, setProfile] = useState('web')
  const [query, setQuery] = useState('')
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null)
  const [installedNames, setInstalledNames] = useState<string[]>([])
  const [installing, setInstalling] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>('default')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [queueDone, setQueueDone] = useState(false)
  // 分批渲染：初始 60，滚动/「加载更多」每次 +60（市场全量 2467 条不一次性渲染）
  const [visibleCount, setVisibleCount] = useState(60)
  const PAGE_STEP = 60
  const { toast, show } = useToast()
  const { t } = useI18n()

  // 当前 Profile 已安装的插件清单（dependencies ∪ bundles）
  useEffect(() => {
    api
      .profilePlugins(profile)
      .then((r) => setInstalledNames((prev) => {
        const merged = new Set([...(prev ?? []), ...(r.installedNames ?? [])])
        return [...merged]
      }))
      .catch(() => {})
  }, [profile])

  useEffect(() => {
    api
      .profiles()
      .then((p) => {
        setProfiles(p)
        if (p.length && !p.some((x) => x.name === profile)) setProfile(p[0]!.name)
      })
      .catch(() => {})
    api
      .market()
      .then(setPlugins)
      .catch((e) => show(e instanceof Error ? e.message : String(e), true))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      setVisibleCount(PAGE_STEP)
      api
        .market(query)
        .then(setPlugins)
        .catch((e) => show(e instanceof Error ? e.message : String(e), true))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  // 排序切换时重置分批
  useEffect(() => {
    setVisibleCount(PAGE_STEP)
  }, [sortBy])

  // 排序：热门（下载量降序）/ 最新（更新时间或创建时间降序）/ 默认
  const sortedPlugins = useMemo(() => {
    const list = [...(plugins ?? [])]
    if (sortBy === 'hot') {
      list.sort((a, b) => {
        const da = Number(a.downloads ?? a.downloadCount ?? 0)
        const db = Number(b.downloads ?? b.downloadCount ?? 0)
        return db - da || Number(b.stars ?? 0) - Number(a.stars ?? 0)
      })
    } else if (sortBy === 'latest') {
      list.sort((a, b) => {
        const ta = new Date((a.updatedAt ?? a.createdAt) as string | number | Date).getTime()
        const tb = new Date((b.updatedAt ?? b.createdAt) as string | number | Date).getTime()
        if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta
        return 0
      })
    }
    return list
  }, [plugins, sortBy])

  async function install(pkg: string, display: string, marketName?: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    setInstalling(pkg)
    try {
      const r = await api.installPlugin(profile, 'add', pkg, marketName)
      if (r.ok) {
        show(`已安装 ${display} → ${profile}`)
        await refreshInstalled()
      } else {
        show(errorLabel(r), true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setInstalling(null)
    }
  }

  async function remove(pkg: string, display: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    if (!window.confirm(`确定从 ${profile} 卸载 ${display}？`)) return
    setInstalling(pkg)
    try {
      const r = await api.uninstallPlugin(profile, pkg)
      if (r.ok) {
        show(`已卸载 ${display}`)
        dropInstalled(pkg)
        await refreshInstalled()
      } else {
        show(r.message || `卸载失败（${r.errorType ?? 'unknown'}）`, true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setInstalling(null)
    }
  }

  async function update(pkg: string, display: string, marketName?: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    setInstalling(pkg)
    try {
      const r = await api.installPlugin(profile, 'update', pkg, marketName)
      if (r.ok) {
        show(`已更新 ${display}`)
        await refreshInstalled()
      } else {
        show(errorLabel(r), true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setInstalling(null)
    }
  }

  /**
   * 刷新已安装状态：合并策略 —— 新结果与当前已装列表取并集（只增不清）。
   * 避免因请求时序/返回空数组导致「已安装」状态闪烁为「未安装」；
   * 卸载成功后调用 removeInstalled 明确移除对应包。
   */
  async function refreshInstalled() {
    try {
      const r = await api.profilePlugins(profile)
      const fresh = r.installedNames ?? []
      setInstalledNames((prev) => {
        const merged = new Set([...(prev ?? []), ...fresh])
        return [...merged]
      })
    } catch {
      /* 忽略（保留当前状态） */
    }
  }

  /** 明确移除某包（卸载成功后调用），避免合并策略残留已卸载插件。 */
  function dropInstalled(pkg: string) {
    setInstalledNames((prev) => (prev ?? []).filter((x) => x !== pkg))
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** 批量安装：串行队列安装，逐个显示进度（1/3、2/3…），失败时标出具体包。 */
  async function batchInstall() {
    const selectedNames = Array.from(selected)
    if (selectedNames.length === 0) return show('请先勾选要安装的插件', true)
    if (!profile) return show('请先选择目标 Profile', true)
    // 每个选中项对应的市场插件（解析真实安装参数）
    const selectedPlugins = sortedPlugins.filter((p) => selected.has(p.name))
    const pkgs = selectedPlugins.map((p) => pkgName(p))
    const marketNames = selectedPlugins.map((p) => p.name)
    if (pkgs.length === 0) return show('选中的插件不在当前列表，请重新选择', true)
    setQueue(pkgs.map((p) => ({ pkg: p, status: 'pending' as const })))
    setQueueDone(false)
    let failedCount = 0
    for (let i = 0; i < pkgs.length; i++) {
      setQueue((prev) => (prev ? prev.map((q, idx) => (idx === i ? { ...q, status: 'installing' as const } : q)) : prev))
      try {
        const r = await api.installPlugin(profile, 'add', pkgs[i]!, marketNames[i])
        if (!r.ok) failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i
                  ? { ...q, status: r.ok ? ('done' as const) : ('error' as const), error: r.ok ? undefined : errorLabel(r) }
                  : q,
              )
            : prev,
        )
      } catch (e) {
        failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i ? { ...q, status: 'error' as const, error: e instanceof Error ? e.message : String(e) } : q,
              )
            : prev,
        )
      }
    }
    setQueueDone(true)
    await refreshInstalled()
    setSelected(new Set())
    show(failedCount > 0 ? `批量安装完成：${pkgs.length - failedCount} 成功，${failedCount} 失败（见进度面板）` : `批量安装完成：${pkgs.length} 个全部成功`)
  }

  const selectedCount = selected.size

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.market.title')}</h1>
        <p className="page-desc">{t('page.market.desc')} · 勾选多个插件可批量安装，支持按热门 / 最新排序</p>
      </div>

      <div className="toolbar">
        <span className="muted">安装到</span>
        <select className="select" value={profile} onChange={(e) => setProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="搜索插件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} title="排序方式">
          <option value="default">默认排序</option>
          <option value="hot">🔥 热门（下载量）</option>
          <option value="latest">🆕 最新</option>
        </select>
        <button className="btn primary" disabled={selectedCount === 0} onClick={() => void batchInstall()}>
          {selectedCount > 0 ? `批量安装（${selectedCount}）` : '批量安装'}
        </button>
        {selectedCount > 0 && (
          <button className="btn sm" onClick={() => setSelected(new Set())}>
            清空选择
          </button>
        )}
      </div>

      {plugins === null ? (
        <Loading />
      ) : sortedPlugins.length === 0 ? (
        <ErrorText message="没有匹配的插件" />
      ) : (
        <>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            共 {sortedPlugins.length} 个插件 · 已显示 {Math.min(visibleCount, sortedPlugins.length)} · 可选{' '}
            {sortedPlugins.filter((p) => !installedNames.includes(pkgName(p))).length} · 已选 {selectedCount}
          </div>
          <div className="grid">
            {sortedPlugins.slice(0, visibleCount).map((p) => {
              const pkg = pkgName(p)
              const installed = installedNames.includes(pkg)
              const isSelected = selected.has(p.name)
              return (
                <div className={`card${isSelected ? ' selected' : ''}`} key={pkg}>
                  <div className="card-title">
                    <label className="checkbox-wrap" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(p.name)}
                        disabled={installed}
                        title={installed ? '已安装的插件无需再次选择' : '勾选后可批量安装'}
                      />
                      <span className="checkbox-label">{isSelected ? '已选' : '选择'}</span>
                    </label>
                    {p.name}
                    {p.npm && p.npm !== p.name ? <span className="badge kind">{p.npm}</span> : null}
                    {p.version ? <span className="badge kind">v{p.version}</span> : null}
                    {installed && <span className="badge enabled">已安装</span>}
                  </div>
                  <p className="card-sub">{desc(p) || '（无描述）'}</p>
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    {categoryLabel(p) && <span className="badge">{categoryLabel(p)}</span>}
                    {fmtCount(p.stars) && <span className="muted">★ {fmtCount(p.stars)}</span>}
                    {fmtCount(p.downloads ?? p.downloadCount) && (
                      <span className="muted">↓ {fmtCount(p.downloads ?? p.downloadCount)}</span>
                    )}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    {installed ? (
                      <>
                        <button className="btn sm" disabled={installing === pkg} onClick={() => update(pkg, p.name, p.name)}>
                          {installing === pkg ? '处理中…' : '更新'}
                        </button>
                        <button className="btn danger sm" disabled={installing === pkg} onClick={() => remove(pkg, p.name)}>
                          卸载
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn primary sm" disabled={installing === pkg} onClick={() => install(pkg, p.name, p.name)}>
                          {installing === pkg ? '安装中…' : '安装'}
                        </button>
                        <button
                          className="btn sm"
                          disabled={installing === pkg}
                          onClick={() => {
                            toggleSelect(p.name)
                            show(isSelected ? '已取消选择' : '已加入批量安装队列')
                          }}
                        >
                          {isSelected ? '取消勾选' : '加入队列'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {visibleCount < sortedPlugins.length && (
            <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
              <button className="btn" onClick={() => setVisibleCount((v) => v + PAGE_STEP)}>
                加载更多（已显示 {Math.min(visibleCount, sortedPlugins.length)} / {sortedPlugins.length}）
              </button>
            </div>
          )}

          {queue && (
            <div className="queue-panel">
              <div className="row">
                <strong>安装进度</strong>
                <span className="muted">
                  {queue.filter((q) => q.status === 'done' || q.status === 'error').length}/{queue.length}
                </span>
                <span className="spacer" />
                {queueDone ? (
                  <button className="btn sm" onClick={() => setQueue(null)}>
                    关闭
                  </button>
                ) : (
                  <span className="muted">正在安装…</span>
                )}
              </div>
              <div className="queue-list">
                {queue.map((q, i) => (
                  <div className={`queue-item ${q.status}`} key={i}>
                    <span className="queue-status">
                      {q.status === 'pending' && '⏳'}
                      {q.status === 'installing' && '🔄'}
                      {q.status === 'done' && '✅'}
                      {q.status === 'error' && '❌'}
                    </span>
                    <span className="queue-name">{q.pkg}</span>
                    <span className="spacer" />
                    <span className="muted">
                      {q.status === 'pending' && '等待中'}
                      {q.status === 'installing' && '安装中…'}
                      {q.status === 'done' && '完成'}
                      {q.status === 'error' && (q.error ?? '安装失败')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}