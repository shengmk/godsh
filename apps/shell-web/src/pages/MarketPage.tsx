import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Package,
  CheckCircle2,
  Download,
  Zap,
  RefreshCw,
  Trash2,
  Rocket,
  Star,
  Check,
  Plus,
  Clock,
  AlertCircle,
  Search,
  RotateCcw,
} from 'lucide-react'
import { api } from '../api'
import type { MarketPlugin, ProfileView, VaultPlugin } from '../types'
import { EmptyState, SkeletonGrid, ToastStack } from '../components'
import { useAsyncAction, useToast } from '../hooks'
import { usePageRefresh } from '../refresh'
import { useConfirm } from '../use-confirm'
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
  other: '操作失败',
}

function errorLabel(r: { errorType?: string; message?: string; stderr?: string }): string {
  const type = r.errorType ?? 'other'
  const label = ERROR_TYPE_LABEL[type] ?? '操作失败'
  const msg = r.message || r.stderr || ''
  return msg ? `${label}：${msg}` : label
}

/**
 * 沙箱仓库接口失败时的提示文案：这些响应体通常不带 message，
 * errorLabel 只能给出「操作失败」，此时保留更具体的原有文案；带明细时拼上真实原因。
 */
function vaultFailText(
  prefix: string,
  r: { ok?: boolean; errorType?: string; message?: string; stderr?: string },
): string {
  const detail = errorLabel(r)
  return detail && detail !== '操作失败' ? `${prefix}：${detail}` : prefix
}

/**
 * 真实安装包名：市场索引的 `name`（展示名）≠ npm 包名。
 * 例如 name='dsh-memory'，npm='@furongjun1999/dsh-memory'——必须用 npm 字段才能装。
 */
function pkgName(p: MarketPlugin): string {
  if (typeof p.npm === 'string' && p.npm.trim()) return p.npm.trim()
  return p.name
}

type SortBy = 'default' | 'hot' | 'latest'
type StatusFilter = 'all' | 'uninstalled' | 'vault' | 'installed'

interface QueueItem {
  pkg: string
  displayName: string
  action: 'profile-install' | 'vault-download'
  status: 'pending' | 'installing' | 'done' | 'error'
  error?: string
}

export default function MarketPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [profile, setProfile] = useState('web')
  const [query, setQuery] = useState('')
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null)
  const [vaultPlugins, setVaultPlugins] = useState<VaultPlugin[]>([])
  const [installedNames, setInstalledNames] = useState<string[]>([])
  /**
   * 单插件正在进行的操作（按包名记录）：区分安装/更新/卸载，用于按钮禁用 + 「进行中」文案。
   * 用 Record 而非单个槽位，多个卡片的操作不会互相覆盖进度显示。
   */
  const [cardActions, setCardActions] = useState<Record<string, 'install' | 'update' | 'remove'>>({})
  /** 沙箱操作中的插件包名（下至沙箱 / 瞬时注入），同样按包名记录避免互相覆盖 */
  const [vaultActing, setVaultActing] = useState<Record<string, boolean>>({})
  const [sortBy, setSortBy] = useState<SortBy>('default')
  const [category, setCategory] = useState('') // '' = 全部
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [queueDone, setQueueDone] = useState(false)
  const [queueTitle, setQueueTitle] = useState('安装进度')
  /** 正在执行的批量动作：用于禁用批量按钮 + 在触发按钮上显示进度（队列面板仍逐项展示进度） */
  const [batchRunning, setBatchRunning] = useState<'install' | 'vault' | null>(null)
  // 分批渲染：初始 60，滚动/「加载更多」每次 +60
  const [visibleCount, setVisibleCount] = useState(60)
  const PAGE_STEP = 60
  const { toasts, show } = useToast()
  const { t } = useI18n()

  const loadVault = useCallback(async () => {
    try {
      const v = await api.vault()
      setVaultPlugins(v)
    } catch {
      /* 忽略 */
    }
  }, [])

  /**
   * 市场数据加载（bug 7）：顶栏全局刷新、页面刷新按钮、空状态「刷新市场」共用同一份逻辑（不重复 fetch）。
   * 不配置 success：加载成功不打扰用户；失败沿用原有原始错误文案。
   */
  const { run: loadMarket, loading: marketLoading } = useAsyncAction(
    useCallback(async (): Promise<void> => {
      const list = await api.market()
      setPlugins(list)
      await loadVault()
    }, [loadVault]),
    { show },
  )

  usePageRefresh(loadMarket, 'market')

  // U5：本页原先的 1 处 window.confirm 改走自研确认框，dialog 在下方 JSX 渲染一次
  const { confirm, dialog } = useConfirm()

  // 单卡片操作占用标记（按包名）：启动时登记、结束时清除，供按钮禁用与进度文案使用
  function markCardAction(pkg: string, kind: 'install' | 'update' | 'remove') {
    setCardActions((prev) => ({ ...prev, [pkg]: kind }))
  }

  function clearCardAction(pkg: string) {
    setCardActions((prev) => {
      const next = { ...prev }
      delete next[pkg]
      return next
    })
  }

  function markVaultActing(pkg: string) {
    setVaultActing((prev) => ({ ...prev, [pkg]: true }))
  }

  function clearVaultActing(pkg: string) {
    setVaultActing((prev) => {
      const next = { ...prev }
      delete next[pkg]
      return next
    })
  }

  // 当前 Profile 已安装的插件清单
  const refreshInstalled = useCallback(async () => {
    if (!profile) return
    try {
      const r = await api.profilePlugins(profile)
      setInstalledNames(r.installedNames ?? [])
    } catch {
      /* 忽略 */
    }
  }, [profile])

  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  useEffect(() => {
    api
      .profiles()
      .then((p) => {
        setProfiles(p)
        if (p.length && !p.some((x) => x.name === profile)) setProfile(p[0]!.name)
      })
      .catch(() => {})
    void loadMarket()
  }, [])

  // 辅助判断是否在沙箱仓库中
  const getVaultPlugin = useCallback(
    (p: MarketPlugin): VaultPlugin | undefined => {
      const pkg = pkgName(p)
      return vaultPlugins.find(
        (v) =>
          v.id === p.name ||
          v.id === pkg ||
          v.name === p.name ||
          v.name === pkg,
      )
    },
    [vaultPlugins],
  )

  // 搜索/分类/状态/排序前端内存即时完成
  const filteredPlugins = useMemo(() => {
    const list = plugins ?? []
    const q = query.trim().toLowerCase()
    let out = list
    if (q) {
      out = out.filter(
        (p) =>
          (p.name ?? '').toLowerCase().includes(q) ||
          (p.npm ?? '').toLowerCase().includes(q) ||
          desc(p).toLowerCase().includes(q),
      )
    }
    if (category) {
      out = out.filter((p) => (p.category as string | undefined) === category)
    }
    if (statusFilter === 'installed') {
      out = out.filter((p) => installedNames.includes(pkgName(p)))
    } else if (statusFilter === 'vault') {
      out = out.filter((p) => Boolean(getVaultPlugin(p)))
    } else if (statusFilter === 'uninstalled') {
      out = out.filter((p) => !installedNames.includes(pkgName(p)))
    }

    if (sortBy === 'hot') {
      out = [...out].sort((a, b) => {
        const da = Number(a.downloads ?? a.downloadCount ?? 0)
        const db = Number(b.downloads ?? b.downloadCount ?? 0)
        return db - da || Number(b.stars ?? 0) - Number(a.stars ?? 0)
      })
    } else if (sortBy === 'latest') {
      out = [...out].sort((a, b) => {
        const ta = new Date((a.updatedAt ?? a.createdAt) as string | number | Date).getTime()
        const tb = new Date((b.updatedAt ?? b.createdAt) as string | number | Date).getTime()
        if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta
        return 0
      })
    }
    return out
  }, [plugins, query, category, statusFilter, sortBy, installedNames, getVaultPlugin])

  // 市场分类统计
  const categoryOptions = useMemo(() => {
    const seen = new Map<string, number>()
    for (const p of plugins ?? []) {
      const c = p.category as string | undefined
      if (c) seen.set(c, (seen.get(c) ?? 0) + 1)
    }
    return [...seen.entries()]
      .map(([cat, cnt]) => ({ cat, zh: CATEGORY_LABEL[cat] ?? cat, cnt }))
      .sort((a, b) => b.cnt - a.cnt)
  }, [plugins])

  // 搜索/分类/排序变化时重置分页
  useEffect(() => {
    setVisibleCount(PAGE_STEP)
  }, [query, category, statusFilter, sortBy])

  // 单插件安装到当前 Profile
  async function installToProfile(pkg: string, display: string, marketName?: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    markCardAction(pkg, 'install')
    try {
      const r = await api.installPlugin(profile, 'add', pkg, marketName)
      if (r.ok) {
        show(`已成功安装 ${display} → ${profile}`)
        await refreshInstalled()
      } else {
        show(errorLabel(r), true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      clearCardAction(pkg)
    }
  }

  // 单插件下载到沙箱仓库 (Vault)
  async function downloadToVault(p: MarketPlugin) {
    const pkg = pkgName(p)
    markVaultActing(pkg)
    try {
      const r = await api.vaultAddMarket({
        name: pkg,
        version: p.version || 'latest',
        description: desc(p),
        category: typeof p.category === 'string' ? p.category : undefined,
      })
      if (r.ok) {
        show(`已将 ${p.name} 成功下载保存至沙箱仓库`)
        await loadVault()
      } else {
        show(vaultFailText('暂存沙箱失败', r), true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      clearVaultActing(pkg)
    }
  }

  // 已安装插件下至沙箱：优先本地反向收割，若无本地物理文件则从市场暂存入库
  async function harvestOrDownloadToVault(p: MarketPlugin) {
    const pkg = pkgName(p)
    markVaultActing(pkg)
    try {
      const r = await api.vaultHarvest(profile, pkg)
      if (r.ok) {
        show(`已成功将环境 [${profile}] 中的 ${p.name} 纳管下至沙箱仓库`)
        await loadVault()
      } else {
        await downloadToVault(p)
      }
    } catch {
      await downloadToVault(p)
    } finally {
      clearVaultActing(pkg)
    }
  }

  // 从沙箱瞬时注入/部署到当前 Profile（busyKey = 卡片包名，保证「注入中…」出现在触发的按钮上）
  async function deployFromVault(vPlugin: VaultPlugin, display: string, busyKey: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    markVaultActing(busyKey)
    try {
      const r = await api.vaultDeploy(vPlugin.id, profile)
      if (r.ok) {
        show(`已从沙箱成功挂载部署 ${display} → ${profile}`)
        await refreshInstalled()
        await loadVault()
      } else {
        show(vaultFailText('沙箱注入失败', r), true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      clearVaultActing(busyKey)
    }
  }

  async function remove(pkg: string, display: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    if (!(await confirm({ message: `确定从 ${profile} 卸载 ${display}？` }))) return
    markCardAction(pkg, 'remove')
    try {
      const r = await api.uninstallPlugin(profile, pkg)
      if (r.ok) {
        show(`已卸载 ${display}`)
        setInstalledNames((prev) => (prev ?? []).filter((x) => x !== pkg))
        await refreshInstalled()
      } else {
        show(r.message || `卸载失败（${r.errorType ?? 'unknown'}）`, true)
      }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      clearCardAction(pkg)
    }
  }

  async function update(pkg: string, display: string, marketName?: string) {
    if (!profile) return show('请先选择目标 Profile', true)
    markCardAction(pkg, 'update')
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
      clearCardAction(pkg)
    }
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // 批量安装到当前 Profile
  async function batchInstall() {
    const selectedNames = Array.from(selected)
    if (selectedNames.length === 0) return show('请先勾选要安装的插件', true)
    if (!profile) return show('请先选择目标 Profile', true)
    const selectedPlugins = (plugins ?? []).filter((p) => selected.has(p.name))
    if (selectedPlugins.length === 0) return show('选中的插件不在列表中，请重新选择', true)

    setQueueTitle(`批量安装到 [${profile}]`)
    setQueue(
      selectedPlugins.map((p) => ({
        pkg: pkgName(p),
        displayName: p.name,
        action: 'profile-install',
        status: 'pending' as const,
      })),
    )
    setQueueDone(false)
    setBatchRunning('install')
    let failedCount = 0

    for (let i = 0; i < selectedPlugins.length; i++) {
      const p = selectedPlugins[i]!
      const pkg = pkgName(p)
      setQueue((prev) =>
        prev ? prev.map((q, idx) => (idx === i ? { ...q, status: 'installing' as const } : q)) : prev,
      )
      try {
        const r = await api.installPlugin(profile, 'add', pkg, p.name)
        if (!r.ok) failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i
                  ? {
                      ...q,
                      status: r.ok ? ('done' as const) : ('error' as const),
                      error: r.ok ? undefined : errorLabel(r),
                    }
                  : q,
              )
            : prev,
        )
      } catch (e) {
        failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i
                  ? { ...q, status: 'error' as const, error: e instanceof Error ? e.message : String(e) }
                  : q,
              )
            : prev,
        )
      }
    }
    setQueueDone(true)
    await refreshInstalled()
    setSelected(new Set())
    show(
      failedCount > 0
        ? `批量安装完成：${selectedPlugins.length - failedCount} 成功，${failedCount} 失败`
        : `批量安装完成：${selectedPlugins.length} 个全部成功`,
    )
    setBatchRunning(null)
  }

  // 批量下载到沙箱仓库 (Vault)
  async function batchDownloadVault() {
    const selectedNames = Array.from(selected)
    if (selectedNames.length === 0) return show('请先勾选要下载到沙箱的插件', true)
    const selectedPlugins = (plugins ?? []).filter((p) => selected.has(p.name))
    if (selectedPlugins.length === 0) return show('选中的插件不在列表中，请重新选择', true)

    setQueueTitle('批量下载到沙箱隔离仓库 (Vault)')
    setQueue(
      selectedPlugins.map((p) => ({
        pkg: pkgName(p),
        displayName: p.name,
        action: 'vault-download',
        status: 'pending' as const,
      })),
    )
    setQueueDone(false)
    setBatchRunning('vault')
    let failedCount = 0

    for (let i = 0; i < selectedPlugins.length; i++) {
      const p = selectedPlugins[i]!
      const pkg = pkgName(p)
      setQueue((prev) =>
        prev ? prev.map((q, idx) => (idx === i ? { ...q, status: 'installing' as const } : q)) : prev,
      )
      try {
        const r = await api.vaultAddMarket({
          name: pkg,
          version: p.version || 'latest',
          description: desc(p),
          category: typeof p.category === 'string' ? p.category : undefined,
        })
        if (!r.ok) failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i
                  ? {
                      ...q,
                      status: r.ok ? ('done' as const) : ('error' as const),
                      error: r.ok ? undefined : '沙箱存储失败',
                    }
                  : q,
              )
            : prev,
        )
      } catch (e) {
        failedCount++
        setQueue((prev) =>
          prev
            ? prev.map((q, idx) =>
                idx === i
                  ? { ...q, status: 'error' as const, error: e instanceof Error ? e.message : String(e) }
                  : q,
              )
            : prev,
        )
      }
    }
    setQueueDone(true)
    await loadVault()
    setSelected(new Set())
    show(
      failedCount > 0
        ? `批量下载沙箱完成：${selectedPlugins.length - failedCount} 成功，${failedCount} 失败`
        : `批量下载沙箱完成：${selectedPlugins.length} 个全部就绪`,
    )
    setBatchRunning(null)
  }

  const selectedCount = selected.size
  const totalMarketCount = plugins?.length ?? 0
  const vaultCount = vaultPlugins.length
  const installedCount = installedNames.length

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.market.title')}</h1>
        <p className="page-desc">
          发现并扩展 Godsh 插件 · 支持一键安全下至沙箱仓库、环境瞬时注入与批量极速安装
        </p>
      </div>

      {/* 顶部多维控制与过滤中枢 */}
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>目标环境:</span>
          <select className="select" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="搜索插件名、npm 标识或功能描述…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} title="按市场分类筛选">
          <option value="">全部分类 ({totalMarketCount})</option>
          {categoryOptions.map((c) => (
            <option key={c.cat} value={c.cat}>
              {c.zh}（{c.cnt}）
            </option>
          ))}
        </select>

        {/* 状态分段控制器 */}
        <div className="segmented-control">
          <button
            className={`segmented-btn ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            全部
          </button>
          <button
            className={`segmented-btn ${statusFilter === 'vault' ? 'active' : ''}`}
            onClick={() => setStatusFilter('vault')}
            title="查看已下载至沙箱隔离仓库的插件"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Package size={12} />
            <span>沙箱就绪 ({vaultCount})</span>
          </button>
          <button
            className={`segmented-btn ${statusFilter === 'installed' ? 'active' : ''}`}
            onClick={() => setStatusFilter('installed')}
            title={`查看已安装至当前 [${profile}] 环境的插件`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <CheckCircle2 size={12} />
            <span>当前已装 ({installedCount})</span>
          </button>
          <button
            className={`segmented-btn ${statusFilter === 'uninstalled' ? 'active' : ''}`}
            onClick={() => setStatusFilter('uninstalled')}
          >
            未安装
          </button>
        </div>

        <select className="select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} title="排序方式">
          <option value="default">默认推荐</option>
          <option value="hot">热门度 (下载与 Star)</option>
          <option value="latest">最新发布</option>
        </select>

        {/* 市场数据刷新（bug 7）：与顶栏全局刷新、空状态「刷新市场」共用 loadMarket */}
        <button
          className="btn sm"
          disabled={marketLoading}
          onClick={() => void loadMarket()}
          title="重新拉取市场索引与沙箱仓库数据"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={13} className={marketLoading ? 'animate-spin' : ''} />
          {marketLoading ? '刷新中…' : '刷新市场'}
        </button>
      </div>

      {/* 批量操作浮动条 */}
      {selectedCount > 0 && (
        <div className="batch-action-bar">
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <span className="badge vault" style={{ fontSize: 13, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Package size={12} />
              <span>已选择 {selectedCount} 项</span>
            </span>
            <button className="btn primary" disabled={batchRunning !== null} onClick={() => void batchInstall()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {batchRunning === 'install' ? (
                <><RefreshCw size={13} className="animate-spin" /> 批量安装中…</>
              ) : (
                <><Zap size={13} /> 批量安装到 [{profile}]</>
              )}
            </button>
            <button className="btn vault" disabled={batchRunning !== null} onClick={() => void batchDownloadVault()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {batchRunning === 'vault' ? (
                <><RefreshCw size={13} className="animate-spin" /> 正在拉取到沙箱…</>
              ) : (
                <><Package size={13} /> 批量下载到沙箱 (Vault)</>
              )}
            </button>
            <button className="btn sm subtle" onClick={() => setSelected(new Set())} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Trash2 size={12} /> 清空选择
            </button>
          </div>
        </div>
      )}

      {plugins === null ? (
        <SkeletonGrid count={8} />
      ) : filteredPlugins.length === 0 ? (
        <EmptyState
          icon={Search}
          title="未找到匹配的插件包"
          description={
            query || category
              ? `在${category ? `「${category}」` : '全部'}分类下未找到与「${query}」匹配的插件。请尝试更换检索关键词或重置筛选条件。`
              : '市场插件列表为空。请检查网络连接或尝试刷新数据。'
          }
          action={{
            label: '重置搜索与分类',
            icon: RotateCcw,
            onClick: () => {
              setQuery('')
              setCategory('')
            },
          }}
          secondaryAction={{
            label: '刷新市场',
            icon: RefreshCw,
            onClick: () => {
              void loadMarket()
            },
          }}
        />
      ) : (
        <>
          <div className="muted" style={{ marginBottom: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
            <span>
              共匹配 <strong>{filteredPlugins.length}</strong> 个插件 · 当前已渲染 {Math.min(visibleCount, filteredPlugins.length)}
            </span>
            {selectedCount > 0 && (
              <span style={{ color: 'var(--brand-text)' }}>已勾选 {selectedCount} 个项目准备批量处理</span>
            )}
          </div>

          <div className="grid">
            {filteredPlugins.slice(0, visibleCount).map((p) => {
              const pkg = pkgName(p)
              const installed = installedNames.includes(pkg)
              const vPlugin = getVaultPlugin(p)
              const inVault = Boolean(vPlugin)
              const isSelected = selected.has(p.name)
              const cardKind = cardActions[pkg] ?? null
              const isInstalling = cardKind !== null
              const isVaultActing = Boolean(vaultActing[pkg])

              return (
                <div className={`card${isSelected ? ' selected' : ''}`} key={pkg}>
                  <div className="card-title">
                    <label className="checkbox-wrap" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(p.name)}
                        title="勾选后可进行批量安装或批量拉取到沙箱"
                      />
                      <span className="checkbox-label">{isSelected ? '已选' : '选择'}</span>
                    </label>

                    <span className="plugin-name" title={p.name}>{p.name}</span>

                    {p.version && <span className="badge kind">v{p.version}</span>}
                    {installed && (
                      <span className="badge enabled" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <CheckCircle2 size={11} /> 已装入 [{profile}]
                      </span>
                    )}
                    {inVault && (
                      <span className="badge vault" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="此插件已在本地沙箱隔离仓库中就绪">
                        <Package size={11} /> 沙箱就绪
                      </span>
                    )}
                  </div>

                  {p.npm && p.npm !== p.name && (
                    <div className="mono-tag" title="npm 安装标识">
                      npm: {p.npm}
                    </div>
                  )}

                  <p className="card-sub">{desc(p) || '（暂无详细说明文档）'}</p>

                  <div className="row" style={{ marginTop: 'auto', gap: 6, alignItems: 'center' }}>
                    {categoryLabel(p) && <span className="badge">{categoryLabel(p)}</span>}
                    {fmtCount(p.stars) && (
                      <span className="muted stat-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Star size={11} style={{ fill: 'currentColor' }} /> {fmtCount(p.stars)}
                      </span>
                    )}
                    {fmtCount(p.downloads ?? p.downloadCount) && (
                      <span className="muted stat-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Download size={11} /> {fmtCount(p.downloads ?? p.downloadCount)}
                      </span>
                    )}
                  </div>

                  <div className="row action-buttons" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
                    {installed ? (
                      <>
                        <button
                          className="btn sm"
                          disabled={isInstalling}
                          onClick={() => update(pkg, p.name, p.name)}
                          title="从官方源检查并更新此插件"
                        >
                          {cardKind === 'update' ? (
                            <><RefreshCw size={12} className="animate-spin" /> 更新中…</>
                          ) : (
                            <><RefreshCw size={12} /> 更新</>
                          )}
                        </button>
                        {inVault ? (
                          <span
                            className="badge vault"
                            style={{ alignSelf: 'center', cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title="此插件已在本地沙箱隔离仓库中就绪"
                          >
                            <Package size={11} /> 沙箱就绪
                          </span>
                        ) : (
                          <button
                            className="btn vault sm"
                            disabled={isInstalling || isVaultActing}
                            onClick={() => void harvestOrDownloadToVault(p)}
                            title="将当前环境中已安装的插件纳管并下至全局沙箱仓库 (Vault)"
                          >
                            {isVaultActing ? (
                              <><RefreshCw size={12} className="animate-spin" /> 存入中…</>
                            ) : (
                              <><Package size={12} /> 下至沙箱</>
                            )}
                          </button>
                        )}
                        <button
                          className="btn danger sm"
                          disabled={isInstalling}
                          onClick={() => remove(pkg, p.name)}
                        >
                          {cardKind === 'remove' ? (
                            <><RefreshCw size={12} className="animate-spin" /> 卸载中…</>
                          ) : (
                            <><Trash2 size={12} /> 卸载</>
                          )}
                        </button>
                      </>
                    ) : (
                      <>
                        {/* 主安装到 Profile */}
                        <button
                          className="btn primary sm"
                          disabled={isInstalling || isVaultActing}
                          onClick={() => installToProfile(pkg, p.name, p.name)}
                          title={`直接安装并配置到当前运行环境 [${profile}]`}
                        >
                          {cardKind === 'install' ? (
                            <><RefreshCw size={12} className="animate-spin" /> 安装中…</>
                          ) : (
                            <><Zap size={12} /> 安装到 {profile}</>
                          )}
                        </button>

                        {/* 沙箱操作双轨 */}
                        {inVault ? (
                          <button
                            className="btn vault-inject-btn sm"
                            disabled={isInstalling || isVaultActing}
                            onClick={() => void deployFromVault(vPlugin!, p.name, pkg)}
                            title="从沙箱秒级挂载注入到当前环境（无需重新下载）"
                          >
                            {isVaultActing ? (
                              <><RefreshCw size={12} className="animate-spin" /> 注入中…</>
                            ) : (
                              <><Rocket size={12} /> 瞬时注入</>
                            )}
                          </button>
                        ) : (
                          <button
                            className="btn vault sm"
                            disabled={isInstalling || isVaultActing}
                            onClick={() => void downloadToVault(p)}
                            title="下载并隔离暂存到沙箱仓库，不污染生产环境"
                          >
                            {isVaultActing ? (
                              <><RefreshCw size={12} className="animate-spin" /> 下载中…</>
                            ) : (
                              <><Package size={12} /> 下至沙箱</>
                            )}
                          </button>
                        )}

                        <button
                          className={`btn sm subtle ${isSelected ? 'active' : ''}`}
                          onClick={() => toggleSelect(p.name)}
                          title="加入/移除批量操作队列"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          {isSelected ? <><Check size={11} /> 取消</> : <><Plus size={11} /> 队列</>}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {visibleCount < filteredPlugins.length && (
            <div className="row" style={{ marginTop: 18, justifyContent: 'center' }}>
              <button className="btn subtle" onClick={() => setVisibleCount((v) => v + PAGE_STEP)}>
                加载更多（已显示 {Math.min(visibleCount, filteredPlugins.length)} / {filteredPlugins.length}）
              </button>
            </div>
          )}

          {/* 队列进度监视器 */}
          {queue && (
            <div className="queue-panel">
              <div className="row" style={{ alignItems: 'center' }}>
                <strong>{queueTitle}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>
                  进度: {queue.filter((q) => q.status === 'done' || q.status === 'error').length} / {queue.length}
                </span>
                <span className="spacer" />
                {queueDone ? (
                  <button className="btn sm primary" onClick={() => setQueue(null)}>
                    完成并关闭
                  </button>
                ) : (
                  <span className="badge running" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span className="pulse-dot active" style={{ width: 6, height: 6, display: 'inline-block' }} /> 处理中…
                  </span>
                )}
              </div>
              <div className="queue-list" style={{ marginTop: 10 }}>
                {queue.map((q, i) => (
                  <div className={`queue-item ${q.status}`} key={i}>
                    <span className="queue-status" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      {q.status === 'pending' && <Clock size={12} />}
                      {q.status === 'installing' && <RefreshCw size={12} className="animate-spin" />}
                      {q.status === 'done' && <CheckCircle2 size={12} style={{ color: 'var(--success)' }} />}
                      {q.status === 'error' && <AlertCircle size={12} style={{ color: 'var(--err)' }} />}
                    </span>
                    <span className="queue-name">{q.displayName}</span>
                    <span className="muted mono-tag" style={{ fontSize: 11 }}>{q.pkg}</span>
                    <span className="spacer" />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {q.status === 'pending' && '排队中…'}
                      {q.status === 'installing' && (q.action === 'vault-download' ? '正在拉取到沙箱…' : '正在安装…')}
                      {q.status === 'done' && '已完成'}
                      {q.status === 'error' && (q.error ?? '执行失败')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <ToastStack toasts={toasts} />
      {dialog}
    </>
  )
}
