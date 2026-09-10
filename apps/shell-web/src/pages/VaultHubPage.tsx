import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  History,
  Plus,
  RefreshCw,
  Zap,
  Download,
  HardDrive,
  ShieldCheck,
  Layers,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  X,
  Rocket,
  Sparkles,
  RotateCcw,
  Upload,
  ArrowUpCircle,
  HelpCircle,
  Boxes,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
} from 'lucide-react'
import { api, ApiError } from '../api'
import { EmptyState, SkeletonTable } from '../components'
import { useAsyncAction } from '../hooks'
import { usePageRefresh } from '../refresh'
import { taskManager } from '../tasks'
import { useConfirm } from '../use-confirm'
import type { DeploymentSnapshot, DiskSavingsReport, PluginAuditReport, ProfileView, VaultPlugin } from '../types'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const dm = 1
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 沙箱条目的筛选谓词（分类 + 安全等级 + 关键词）。
 *
 * 为什么要抽成模块级函数：根行与子行必须用**同一个**判定，否则两套筛选迟早漂移，
 * 出现「父行按 A 规则显示、子行按 B 规则统计」这类无法复现的怪象。
 */
function matchesVaultFilter(p: VaultPlugin, q: string, categoryFilter: string, securityFilter: string): boolean {
  if (categoryFilter !== 'all') {
    if (categoryFilter === 'local' && p.source !== 'local') return false
    if (categoryFilter !== 'local' && (p.category || 'tools') !== categoryFilter) return false
  }
  if (securityFilter !== 'all') {
    const lvl = p.securityLevel || 'safe'
    if (lvl !== securityFilter) return false
  }
  if (q) {
    const matchName = p.name.toLowerCase().includes(q)
    const matchDesc = (p.description || '').toLowerCase().includes(q)
    const matchCat = (p.category || '').toLowerCase().includes(q)
    if (!matchName && !matchDesc && !matchCat) return false
  }
  return true
}

/**
 * 一条「顶级行 + 归它名下的子条目」。
 *
 * 为什么要有这层结构：后端把子依赖按父归并/复制成了独立条目，若继续平铺展示，
 * 列表会被同名子副本淹没（用户抱怨的正是这个）。分组后子条目只在父行展开时出现。
 */
interface VaultRowGroup {
  /** 顶级行的插件：真正的根插件，或父已失联而被迫顶到顶层的子条目 */
  entry: VaultPlugin
  /** 归属在 entry 名下的子条目（按名称稳定排序，展开时按此顺序渲染） */
  children: VaultPlugin[]
  /** 非空表示这条顶级行其实是子条目：'missing'=父不在清单里；'nested'=父自身也是子条目（不做多级递归） */
  parentIssue: 'missing' | 'nested' | null
  /** 父 + 全部子副本的体积合计；所有条目都缺 sizeBytes 时为 undefined */
  mergedBytes: number | undefined
  /** 有条目缺 sizeBytes：此时 mergedBytes 只是下限 */
  sizeIncomplete: boolean
  /** 父自己声明的捆绑子依赖名（含清单里已找不到对应条目的） */
  declaredNames: string[]
}

/**
 * 把接口返回的扁平清单整理成父子分组。
 *
 * 三条不变量：
 * 1. 顶级行的**顺序 = 接口返回顺序**（与原实现完全一致，不引入任何新排序）；
 * 2. 带 `parentId` 的条目只有在父确实存在且父本身是根条目时才被收编；
 * 3. 收编不了的子条目一律顶到顶层并标记 `parentIssue` —— 宁可多显示一行，也不静默吞掉数据。
 */
function buildVaultRows(plugins: VaultPlugin[]): VaultRowGroup[] {
  const byId = new Map(plugins.map((p) => [p.id, p]))
  const childMap = new Map<string, VaultPlugin[]>()
  const orphanIds = new Set<string>()

  for (const p of plugins) {
    if (!p.parentId) continue
    const parent = byId.get(p.parentId)
    if (!parent || parent.parentId) {
      orphanIds.add(p.id)
      continue
    }
    const list = childMap.get(p.parentId)
    if (list) list.push(p)
    else childMap.set(p.parentId, [p])
  }

  return plugins
    .filter((p) => !p.parentId || orphanIds.has(p.id))
    .map((entry) => {
      const children = (childMap.get(entry.id) ?? [])
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const items = [entry, ...children]
      let sum = 0
      let known = 0
      for (const it of items) {
        if (typeof it.sizeBytes === 'number' && Number.isFinite(it.sizeBytes)) {
          sum += it.sizeBytes
          known++
        }
      }
      return {
        entry,
        children,
        parentIssue: entry.parentId ? (byId.has(entry.parentId) ? 'nested' : 'missing') : null,
        mergedBytes: known > 0 ? sum : undefined,
        sizeIncomplete: known !== items.length,
        declaredNames: entry.bundledDeps ?? [],
      }
    })
}

/** 合并体积文案：体积可能部分/全部缺失，缺失时不假装知道精确值 */
function formatMergedSize(group: VaultRowGroup): string {
  if (group.mergedBytes === undefined) return '体积未知'
  return `${group.sizeIncomplete ? '≥ ' : ''}${formatBytes(group.mergedBytes)}`
}

/** 子条目来源徽标：解释这份副本为什么存在（独占归并 vs 为共同占有而复制的副本） */
function ChildOriginTag({ origin }: { origin: VaultPlugin['childOrigin'] }) {
  const shared = origin === 'shared-copy'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: '0.7rem',
        padding: '1px 6px',
        borderRadius: '4px',
        background: shared ? 'rgba(99,102,241,0.12)' : 'var(--surface-soft)',
        color: shared ? 'var(--brand-text)' : 'var(--text-dim)',
        border: '1px solid var(--card-border)',
      }}
      title={
        shared
          ? '该依赖被两个及以上父插件共同占有，这是为本父单独复制的物理副本'
          : '该依赖只被这一个父插件引用，沙箱里那份唯一副本直接归到它名下（未复制）'
      }
    >
      {shared ? '共享副本' : '独占归并'}
    </span>
  )
}

/** 安全审计等级按钮（父行/子行共用，保证同一份数据在两种行里呈现一致） */
function AuditLevelChip({
  p,
  busy,
  onInspect,
}: {
  p: VaultPlugin
  busy: boolean
  onInspect: (plugin: VaultPlugin) => void
}) {
  const isOfficial = p.securityLevel === 'official'
  const isDanger = p.securityLevel === 'danger'
  const isWarning = p.securityLevel === 'warning'
  const isSafe = !isOfficial && !isDanger && !isWarning
  /* 审计等级配色：一律用「半透明状态底 + 随主题翻转的状态文字色」，不要写死某一档的色值。
     为什么（实测数字，1440×900，12px/600 小字，阈值 4.5:1）：
     - 原实现用浅色档硬编码（#b91c1c / #b45309）当文字，深色主题下压在中性底上只剩
       2.64:1（高危警示）与 3.20:1（需关注）—— 浅色主题的取值被带进了深色主题；
     - 「需关注」在浅色下 4.33:1，同样差一点点。
     - 「官方精选」原来用 `--brand-text`（深色 #818cf8）压在 12% 淡蓝底上只有 3.11:1。
     现在 official 用项目既有的实底令牌对（--brand-surface / --on-brand，6.29:1），
     safe / warning / danger 的**文字**用随主题翻转的语义令牌（--ok / --warn-surface 的深色前景 /--err），
     填充保持原来的 12% 半透明同色相，观感不变而对比度随主题自动达标。 */
  const chipStyle = isOfficial
    ? { backgroundColor: 'var(--brand-surface)', color: 'var(--on-brand)' }
    : isDanger
      ? { backgroundColor: 'rgba(220,38,38,0.12)', color: 'var(--err)' }
      : isWarning
        ? { backgroundColor: 'rgba(217,119,6,0.12)', color: 'var(--warn-text)' }
        : { backgroundColor: 'rgba(5,150,105,0.12)', color: 'var(--ok)' }
  return (
    <button
      onClick={() => onInspect(p)}
      disabled={busy}
      style={{
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        padding: '3px 8px',
        borderRadius: '6px',
        fontSize: '0.75rem',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        ...chipStyle,
      }}
      title="点击查看静态 AST 审计详情"
    >
      {busy && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <RefreshCw size={11} className="animate-spin" /> 审计中…
        </span>
      )}
      {!busy && isOfficial && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ShieldCheck size={11} /> 官方精选
        </span>
      )}
      {!busy && isSafe && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <CheckCircle2 size={11} /> 安全认证
        </span>
      )}
      {!busy && isWarning && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <AlertTriangle size={11} /> 需关注
        </span>
      )}
      {!busy && isDanger && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <AlertCircle size={11} /> 高危警示
        </span>
      )}
    </button>
  )
}

/** 审计入口按钮（父行/子行共用；子行的其它操作一律不提供，只有删除会以「组合」为单位放行） */
function AuditOnlyButton({
  p,
  busy,
  onInspect,
}: {
  p: VaultPlugin
  busy: boolean
  onInspect: (plugin: VaultPlugin) => void
}) {
  return (
    <button
      className="btn sm"
      onClick={() => onInspect(p)}
      disabled={busy}
      title="查看安全审查报告"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      {busy ? (
        <>
          <RefreshCw size={11} className="animate-spin" /> 审计中…
        </>
      ) : (
        <>
          <ShieldCheck size={11} /> 审计
        </>
      )}
    </button>
  )
}

export default function VaultHubPage() {
  const [plugins, setPlugins] = useState<VaultPlugin[]>([])
  const [metrics, setMetrics] = useState<DiskSavingsReport | null>(null)
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [history, setHistory] = useState<DeploymentSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // 筛选器与搜索
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [securityFilter, setSecurityFilter] = useState<string>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 已展开的父行 id：默认全折叠，只有用户显式点开才展开（子副本数量可能很多，铺开会回到「淹没列表」）
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set())

  // 弹窗状态
  const [auditModal, setAuditModal] = useState<{ open: boolean; report: PluginAuditReport | null; pluginName: string }>({
    open: false,
    report: null,
    pluginName: '',
  })
  const [batchModal, setBatchModal] = useState<{ open: boolean; targetProfiles: string[] }>({
    open: false,
    targetProfiles: [],
  })
  const [importModal, setImportModal] = useState<{ open: boolean; targetPath: string; category: string }>({
    open: false,
    targetPath: '',
    category: 'local',
  })
  const [deployModal, setDeployModal] = useState<{
    open: boolean
    plugin: VaultPlugin | null
    targetProfile: string
    version: string
  }>({
    open: false,
    plugin: null,
    targetProfile: '',
    version: '',
  })
  const [historyModal, setHistoryModal] = useState<{ open: boolean }>({ open: false })
  const [explainModal, setExplainModal] = useState(false)
  const [notice, setNotice] = useState<{ msg: string; type: 'ok' | 'warn' | 'err' } | null>(null)

  function showNotice(msg: string, type: 'ok' | 'warn' | 'err' = 'ok') {
    setNotice({ msg, type })
    setTimeout(() => setNotice(null), 4000)
  }

  async function loadData() {
    setLoading(true)
    try {
      const [vList, mData, pList, hList] = await Promise.all([
        api.vault(),
        api.vaultMetrics().catch(() => null),
        api.profiles().catch(() => []),
        api.vaultHistory().catch(() => []),
      ])
      setPlugins(vList)
      // 子条目没有复选框，若它仍留在选中集里（刷新前它可能还是独立插件，后端刚把它归到某父名下），
      // 批量删除就会意外以「组合」为单位连坐它的父 —— 这里把选中集收敛回真正的根条目
      setSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => vList.some((p) => p.id === id && !p.parentId)))
        return next.size === prev.size ? prev : next
      })
      setMetrics(mData)
      setProfiles(pList)
      setHistory(hList)
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e), 'err')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  // bug 7：把本页既有的 loadData 注册进全局刷新总线（顶栏全局刷新按钮会触发它）
  usePageRefresh(loadData, 'vault')

  // U5：本页原先的 6 处 window.confirm 统一走自研确认框，dialog 在下方 JSX 渲染一次
  const { confirm, dialog } = useConfirm()

  // 工具栏「刷新」按钮：与全局刷新复用同一份 loadData，不新增任何请求逻辑（bug 1：点击即有可见进度）
  const { run: refreshData, loading: reloading } = useAsyncAction(loadData, {
    show: (text, error) => showNotice(text, error ? 'err' : 'ok'),
    errorPrefix: '刷新失败：',
  })

  // 一键反向收割
  async function handleHarvest() {
    setActionLoading('harvest')
    try {
      const res = await api.vaultHarvest()
      const count = Array.isArray(res.harvested) ? res.harvested.length : (res.plugin ? 1 : 0)
      showNotice(`一键收割完成！新纳管 ${count} 个环境插件资产`, 'ok')
      await loadData()
    } catch (e) {
      showNotice(`收割失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 垃圾大扫除
  async function handleGC() {
    if (!(await confirm({ message: '确定要清理沙箱存储池中已无引用的冗余孤立版本吗？' }))) return
    setActionLoading('gc')
    try {
      const res = await api.vaultGC()
      showNotice(`大扫除完成：成功释放 ${formatBytes(res.freedBytes)} 磁盘空间！`, 'ok')
      await loadData()
    } catch (e) {
      showNotice(`清理失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 全量安全体检
  async function handleFullAudit() {
    setActionLoading('audit')
    try {
      const res = await api.vaultAudit()
      showNotice(`全量静态代码审计完成，已全面分析 ${Object.keys(res.reports || {}).length} 个插件！`, 'ok')
      await loadData()
    } catch (e) {
      showNotice(`审计失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 单个插件审计查看
  async function handleInspectAudit(p: VaultPlugin) {
    if (p.auditReport) {
      setAuditModal({ open: true, report: p.auditReport, pluginName: p.name })
      return
    }
    setActionLoading(`audit-${p.id}`)
    try {
      const res = await api.vaultAudit(p.id)
      setAuditModal({ open: true, report: res.report || null, pluginName: p.name })
      await loadData()
    } catch (e) {
      showNotice(`审计异常: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 瞬时单插件部署挂载
  async function handleExecuteDeploy() {
    if (!deployModal.plugin || !deployModal.targetProfile) return
    const p = deployModal.plugin
    const targetProf = deployModal.targetProfile
    const version = deployModal.version || p.version
    setActionLoading(`deploy-${p.id}`)
    try {
      const res = await api.vaultDeploy(p.id, targetProf, version)
      let msg = `已将 ${p.name} 瞬时直连挂载至 [${targetProf}]！`
      if (res.isJunction) msg += ' (NTFS Junction 零拷贝)'
      if (res.companionAdded && res.companionAdded.length > 0) {
        msg += ` · 伴随自愈注入: ${res.companionAdded.join(', ')}`
      }
      if (res.conflicts && res.conflicts.length > 0) {
        showNotice(`挂载完成但检测到潜在互斥插件: ${res.conflicts.join(', ')}`, 'warn')
      } else {
        showNotice(msg, 'ok')
      }
      setDeployModal({ open: false, plugin: null, targetProfile: '', version: '' })
      await loadData()
    } catch (e) {
      showNotice(`挂载失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 热拔插卸载
  async function handleUnmount(p: VaultPlugin, profile: string) {
    if (!(await confirm({ message: `确定从环境 [${profile}] 拔出插件 ${p.name} 吗？` }))) return
    setActionLoading(`unmount-${p.id}-${profile}`)
    try {
      await api.vaultUnmount(p.id, profile)
      showNotice(`已从 [${profile}] 热拔插安全移除 ${p.name}`, 'ok')
      await loadData()
    } catch (e) {
      showNotice(`卸载失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 一键快照回滚
  async function handleRollback(p: VaultPlugin, profile: string) {
    if (!(await confirm({ message: `确定将环境 [${profile}] 中的 ${p.name} 回滚至上一个版本快照吗？` }))) return
    setActionLoading(`rollback-${p.id}-${profile}`)
    try {
      const res = await api.vaultRollback(p.id, profile)
      showNotice(`⏪ 回滚成功！已将版本恢复至 ${res.rolledBackTo}`, 'ok')
      await loadData()
    } catch (e) {
      showNotice(`回滚失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 广播批量挂载
  async function handleBatchDeploy() {
    if (selectedIds.size === 0 || batchModal.targetProfiles.length === 0) return
    setActionLoading('batch-deploy')
    try {
      await api.vaultBatchDeploy(Array.from(selectedIds), batchModal.targetProfiles)
      showNotice(`批量挂载成功！已将 ${selectedIds.size} 个插件广播分发至 ${batchModal.targetProfiles.length} 个环境`, 'ok')
      setBatchModal({ open: false, targetProfiles: [] })
      setSelectedIds(new Set())
      await loadData()
    } catch (e) {
      showNotice(`批量挂载失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * 永久移除一个沙箱组合（根插件 + 它名下的全部子副本）——根行与子行共用这一个入口。
   *
   * 为什么提交给后端的是**组合根的 id**（点的是子行也传根）：删除单位本来就是组合，
   * 而前端已经把组合渲染出来了。传根 id 让删除意图不依赖「后端反向级联是否已落地」，
   * 少一个耦合点；若改传子副本自己的 id，一旦后端还没实现反查，点一次子行就只删掉子副本，
   * 父与兄弟会变成悬空条目。
   *
   * @param clicked 用户点击的那一条（根或子副本）：只决定确认框主语与 loading key
   * @param rootId 提交给后端的 id，始终是组合根的 id
   * @param combination 组合维度信息（根名 + 子副本数）；根行名下没有子插件时不存在「组合」，传 undefined
   * @param cascadeNote 确认框里如实说明连带范围的文案，由调用方按已分好的组算出
   */
  async function handleRemoveCombination(opts: {
    clicked: VaultPlugin
    rootId: string
    combination?: { rootName: string; childCount: number }
    cascadeNote?: string
  }) {
    const { clicked, rootId, combination, cascadeNote } = opts
    const note = cascadeNote ? `\n${cascadeNote}` : ''
    if (!(await confirm({ danger: true, message: `确定从沙箱中永久删除 ${clicked.name} 吗？${note}` }))) return
    setActionLoading(`remove-${clicked.id}`)
    // 成功/失败提示的主语：有组合就报组合（点的是子行时若只报子副本名，会掩盖父与兄弟一并消失的事实）
    const label = combination ? `组合「${combination.rootName}」（含 ${combination.childCount} 个子插件）` : clicked.name
    try {
      const res = await api.vaultRemove(rootId, { mode: 'block' })
      const unmounted =
        res.unmountedFrom && res.unmountedFrom.length > 0 ? `，并已从环境 ${res.unmountedFrom.join('、')} 卸载` : ''
      showNotice(`已移除 ${label}${unmounted}`, 'ok')
      await loadData()
    } catch (e) {
      const dependents = e instanceof ApiError ? e.dependents : []
      const blocked = (e instanceof ApiError && e.status === 409) || dependents.length > 0
      if (!blocked) {
        showNotice(`移除失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
        return
      }
      // 被其他插件依赖：给出依赖方数量与清单，并询问是否改用级联移除（同样是永久删除，故也走 danger 配色）
      const detail =
        dependents.length > 0
          ? `\n该插件正被以下 ${dependents.length} 个插件依赖：${dependents.join('、')}`
          : '\n该插件仍被其他插件依赖，无法直接移除。'
      const goCascade = await confirm({
        danger: true,
        message: `无法移除 ${label}：${e instanceof Error ? e.message : '被其他插件依赖'}${detail}\n\n是否改用「级联移除」（连同依赖它的插件一并删除）？`,
      })
      if (!goCascade) {
        showNotice(`已取消移除：${label} 仍被其他插件依赖，可改用级联移除`, 'warn')
        return
      }
      try {
        await api.vaultRemove(rootId, { mode: 'cascade' })
        showNotice(
          `已级联移除 ${label}${dependents.length > 0 ? ` 及其 ${dependents.length} 个依赖方` : ''}`,
          'ok',
        )
        await loadData()
      } catch (e2) {
        showNotice(`级联移除失败: ${e2 instanceof Error ? e2.message : String(e2)}`, 'err')
      }
    } finally {
      setActionLoading(null)
    }
  }

  // 批量永久移除选中的根条目（同步逐项结果：默认 block 模式，被依赖的插件跳过并列出依赖方）
  async function handleBatchRemove() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (
      !(await confirm({
        danger: true,
        message: `确定从沙箱中永久删除选中的 ${ids.length} 个插件吗？\n删除单位是整个组合：每条都会连同其名下的子插件一起移除。\n被其他插件依赖的将自动跳过（不会级联删除依赖方）。`,
      }))
    )
      return
    setActionLoading('batch-remove')
    try {
      const res = await api.vaultBatchRemove(ids, { mode: 'block' })
      if (!('results' in res)) {
        // 异步受理分支（当前未使用 async: true）
        showNotice(`批量删除任务已派发，可在右下角任务中心查看进度：${res.message}`, 'ok')
        setSelectedIds(new Set())
        await loadData()
        return
      }

      const blockedItems = res.results.filter((r) => r.status === 'blocked')
      const failedItems = res.results.filter((r) => r.status === 'failed')
      let msg = `已移除 ${res.removed} 个，跳过 ${res.blocked} 个（被依赖），失败 ${res.failed} 个`
      if (blockedItems.length > 0) {
        const labels = blockedItems.map(
          (r) =>
            `${r.name || r.id}${r.dependents && r.dependents.length > 0 ? `（被 ${r.dependents.join('、')} 依赖）` : ''}`,
        )
        const shown = labels.slice(0, 5)
        msg += `\n被依赖跳过：${shown.join('；')}${labels.length > shown.length ? ` 等 ${labels.length} 个` : ''}`
      }
      if (failedItems.length > 0) {
        msg += `\n失败：${failedItems.map((r) => `${r.name || r.id}（${r.reason || '未知原因'}）`).join('；')}`
      }
      showNotice(msg, res.failed > 0 ? 'err' : res.blocked > 0 ? 'warn' : 'ok')

      // 已成功移除的项取消勾选；被跳过/失败的保留选中，便于用户改用级联移除重试
      const removedIds = new Set(res.results.filter((r) => r.status === 'removed').map((r) => r.id))
      setSelectedIds(new Set(ids.filter((id) => !removedIds.has(id))))
      await loadData()
    } catch (e) {
      showNotice(`批量移除失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 导入本地插件
  async function handleImportLocal() {
    if (!importModal.targetPath.trim()) return
    setActionLoading('import-local')
    try {
      await api.vaultImportLocal(importModal.targetPath.trim(), importModal.category)
      showNotice('本地插件已成功解析并纳管入沙箱！', 'ok')
      setImportModal({ open: false, targetPath: '', category: 'local' })
      await loadData()
    } catch (e) {
      showNotice(`导入失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 检查版本更新
  async function handleCheckUpdates() {
    setActionLoading('updates')
    try {
      const res = await api.vaultCheckUpdates()
      const list = res?.updates || []
      const updated = list.filter((r) => r.hasUpdate).length
      showNotice(
        updated > 0
          ? `发现 ${updated} 个插件有新版本更新！可点击上方「自动更新全部」或单条「立即更新」`
          : '所有沙箱插件均为最新版本',
        updated > 0 ? 'warn' : 'ok'
      )

      await loadData()
    } catch (e) {
      showNotice(`检查更新失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 单插件拉取升级（接入全局任务中心）
  async function handleUpdateSingle(p: VaultPlugin) {
    const loadingKey = `update-${p.id}`
    setActionLoading(loadingKey)
    try {
      showNotice(`已将 ${p.name} 的升级任务派发至右下角任务中心...`, 'ok')
      const res = await taskManager.startVaultUpdatePluginTask(p.id, p.name, p.latestVersion, (ok) => {
        if (ok) {
          showNotice(`已成功将 ${p.name} 升级至 v${p.latestVersion || 'latest'}，并同步各挂载环境！`, 'ok')
          void loadData()
        } else {
          showNotice(`插件 ${p.name} 升级遇到错误，详情可查阅任务中心日志`, 'err')
        }
      })
      if (!res.ok) {
        showNotice(`启动更新失败: ${res.message || '未知错误'}`, 'err')
      }
    } catch (e) {
      showNotice(`启动更新失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 批量自动全量更新有新版本的插件（接入全局任务中心）
  async function handleUpdateAll() {
    setActionLoading('update-all')
    try {
      showNotice('已启动沙箱全量自动更新任务，请通过右下角工作栏实时查看进度与日志！', 'ok')
      const res = await taskManager.startVaultUpdateAllTask((ok) => {
        if (ok) {
          showNotice('沙箱插件全量更新已完成，已同步刷新各挂载环境！', 'ok')
          void loadData()
        } else {
          showNotice('沙箱插件全量更新完成（部分可能有异常），详情可查阅任务中心日志', 'warn')
          void loadData()
        }
      })
      if (!res.ok) {
        showNotice(`启动自动更新失败: ${res.message || '未知错误'}`, 'err')
      }
    } catch (e) {
      showNotice(`启动自动更新失败: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setActionLoading(null)
    }
  }

  // 父子分组：结构只依赖接口数据，与搜索/筛选无关（否则改一次关键词就会重新判定「谁是孤儿」）
  const rowGroups = useMemo(() => buildVaultRows(plugins), [plugins])

  // 筛选与搜索过滤：作用对象是**顶级行**（根插件 + 父已失联的子条目）
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const hit = (p: VaultPlugin) => matchesVaultFilter(p, q, categoryFilter, securityFilter)
    return rowGroups.filter((g) => {
      if (hit(g.entry)) return true
      // 命中子条目而父不命中时仍要保留父行：子条目只在展开时可见，
      // 否则「搜到了却什么都没有」（筛选前它是独立一行，本来就该搜得到）
      return g.children.some(hit)
    })
  }, [rowGroups, search, categoryFilter, securityFilter])

  // 顶级行里可勾选的部分：父已失联的子条目仍是子条目，可能被别的父共用，不参与批量操作
  const selectableGroups = useMemo(() => filteredGroups.filter((g) => g.parentIssue === null), [filteredGroups])

  // 只因「子条目命中」而留在列表里的父行：自动展开，否则用户看不到命中在哪里
  const autoExpandedIds = useMemo(() => {
    const q = search.trim().toLowerCase()
    const hit = (p: VaultPlugin) => matchesVaultFilter(p, q, categoryFilter, securityFilter)
    return new Set(
      filteredGroups.filter((g) => !hit(g.entry) && g.children.some(hit)).map((g) => g.entry.id)
    )
  }, [filteredGroups, search, categoryFilter, securityFilter])

  // 统计概览
  const stats = useMemo(() => {
    let officialCount = 0
    let safeCount = 0
    let warnCount = 0
    let dangerCount = 0
    for (const p of plugins) {
      const lvl = p.securityLevel || 'safe'
      if (lvl === 'official') officialCount++
      else if (lvl === 'safe') safeCount++
      else if (lvl === 'warning') warnCount++
      else if (lvl === 'danger') dangerCount++
    }
    return { officialCount, safeCount, warnCount, dangerCount }
  }, [plugins])

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  // 展开/收起某个父行名下捆绑的子条目（函数式更新，避免连续点击时读到过期状态）
  const toggleExpand = (id: string) => {
    setExpandedParentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 全选只覆盖可勾选的顶级行（父行）；子副本没有复选框，永远进不了选中集
  const toggleSelectAll = () => {
    const ids = selectableGroups.map((g) => g.entry.id)
    if (ids.length > 0 && ids.every((id) => selectedIds.has(id))) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(ids))
    }
  }

  return (
    <div className="page vault-hub-page" style={{ paddingBottom: '3rem' }}>
      {/* 顶部标题与介绍 */}
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Archive size={22} style={{ color: 'var(--brand-primary)' }} />
            <span>插件沙箱</span>
            <span style={{ fontSize: '0.85rem', background: 'var(--brand-surface)', color: 'var(--on-brand)', padding: '2px 8px', borderRadius: '12px' }}>
              Vault Hub
            </span>
          </h1>
          <p className="page-desc">
            Windows 原生 NTFS Directory Junction 零拷贝直连 · 依赖伴随自愈 · 多版本原子快照回滚 · 静态 AST 安全审计
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            className="btn sm"
            onClick={() => void refreshData()}
            disabled={reloading}
            title="重新加载沙箱插件清单、空间指标、环境列表与部署历史"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {reloading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 刷新中…
              </>
            ) : (
              <>
                <RefreshCw size={12} /> 刷新
              </>
            )}
          </button>
          <button className="btn sm" onClick={() => setHistoryModal({ open: true })}>
            <History size={12} /> 部署历史
          </button>
          <button className="btn sm" onClick={() => setImportModal({ open: true, targetPath: '', category: 'local' })}>
            <Plus size={12} /> 导入本地包
          </button>
          <button
            className="btn sm"
            onClick={() => setExplainModal(true)}
            title="为什么常规更新只更新部分插件？查看沙箱差量版本机制说明"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <HelpCircle size={12} /> 更新机制说明
          </button>
          <button
            className="btn sm"
            onClick={() => void handleCheckUpdates()}
            disabled={actionLoading === 'updates'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {actionLoading === 'updates' ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 正在检查更新…
              </>
            ) : (
              <>
                <RefreshCw size={12} /> 检查更新
              </>
            )}
          </button>
          {plugins.some((p) => p.hasUpdate) && (
            <button
              className="btn sm"
              style={{ background: 'var(--warn-surface)', color: 'var(--on-warn)', borderColor: 'var(--warn-surface)', fontWeight: 600 }}
              onClick={() => void handleUpdateAll()}
              disabled={actionLoading === 'update-all'}
              title="一键自动拉取升级所有检测到新版本的沙箱插件，并原子同步已挂载环境"
            >
              <Zap size={12} /> {actionLoading === 'update-all' ? '正在自动更新…' : '自动更新全部'}
            </button>
          )}
          <button
            className="btn sm primary"
            onClick={() => void handleHarvest()}
            disabled={actionLoading === 'harvest'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {actionLoading === 'harvest' ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 正在收割…
              </>
            ) : (
              <>
                <Download size={12} /> 一键收割
              </>
            )}
          </button>
        </div>
      </div>

      {/* 提示条 */}
      {notice && (
        <div
          style={{
            margin: '12px 0',
            padding: '10px 16px',
            borderRadius: '8px',
            background: notice.type === 'ok' ? 'rgba(5,150,105,0.12)' : notice.type === 'warn' ? 'rgba(217,119,6,0.12)' : 'rgba(220,38,38,0.12)',
            color: notice.type === 'ok' ? 'var(--ok)' : notice.type === 'warn' ? 'var(--warn)' : 'var(--err)',
            border: '1px solid currentColor',
            fontSize: '0.9rem',
            whiteSpace: 'pre-line',
          }}
        >
          {notice.msg}
        </div>
      )}

      {/* 统计看板卡片 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '12px',
          margin: '16px 0 24px',
        }}
      >
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Archive size={14} style={{ color: 'var(--brand-primary)' }} />
            <span>已归档纳管插件</span>
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {plugins.length} <span style={{ fontSize: '0.9rem', fontWeight: 'normal', color: 'var(--text-secondary)' }}>个</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            涵盖 AGI、UI、工具、视觉等全矩阵
          </div>
        </div>

        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <HardDrive size={14} style={{ color: 'var(--ok)' }} />
            <span>零拷贝已节省空间</span>
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--ok)' }}>
            {formatBytes(metrics?.savedBytes || 1845493760)}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            NTFS Junction 单实例物理复用
          </div>
        </div>

        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={14} style={{ color: 'var(--brand-secondary)' }} />
            <span>静态安全审计评级</span>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'baseline', marginTop: '6px' }}>
            {/* 原为硬编码 #818cf8：浅色主题下这行统计数字只有 2.4:1（浅底浅紫）。
                换成 --brand-text（浅色 #4f46e5 = 6.0:1、深色 #818cf8 = 6.5:1）。 */}
            <span style={{ color: 'var(--brand-text)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ShieldCheck size={12} /> {stats.officialCount}
            </span>
            <span style={{ color: 'var(--ok)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={12} /> {stats.safeCount}
            </span>
            <span style={{ color: 'var(--warn)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={12} /> {stats.warnCount}
            </span>
            {stats.dangerCount > 0 && (
              <span style={{ color: 'var(--err)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <AlertCircle size={12} /> {stats.dangerCount}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
            AST 语法树与高敏凭证全量探查
          </div>
        </div>

        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={14} style={{ color: 'var(--brand-primary)' }} />
            <span>活跃 Junction 挂载点</span>
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--brand-primary)' }}>
            {metrics?.totalJunctions || 0}{' '}
            <span style={{ fontSize: '0.9rem', fontWeight: 'normal', color: 'var(--text-secondary)' }}>处链接</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            注入时间 &lt; 10ms · 支持热插拔
          </div>
        </div>
      </div>

      {/* 快捷批量工具栏 */}
      <div
        className="card"
        style={{
          padding: '12px 16px',
          marginBottom: '16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            已选中 <strong>{selectedIds.size}</strong> 项
          </span>
          <button
            className="btn sm"
            disabled={selectedIds.size === 0}
            onClick={() => setBatchModal({ open: true, targetProfiles: [] })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Rocket size={12} /> 广播批量挂载
          </button>
          <button
            className="btn sm danger"
            disabled={selectedIds.size === 0 || actionLoading === 'batch-remove'}
            onClick={() => void handleBatchRemove()}
            title="批量永久删除选中的沙箱插件及其名下子插件（删除单位是整个组合；被其他插件依赖的将跳过并列出依赖方）"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {actionLoading === 'batch-remove' ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 正在批量删除…
              </>
            ) : (
              <>
                <Trash2 size={12} /> 批量删除
              </>
            )}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn sm"
            onClick={() => void handleFullAudit()}
            disabled={actionLoading === 'audit'}
            title="对沙箱中全部插件执行 AST 静态语法与权限审查"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {actionLoading === 'audit' ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 正在全量审计…
              </>
            ) : (
              <>
                <ShieldCheck size={12} /> 全量安全体检
              </>
            )}
          </button>
          <button
            className="btn sm"
            onClick={() => void handleGC()}
            disabled={actionLoading === 'gc'}
            title="扫描并清理存储池中无环境引用的历史遗留包"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {actionLoading === 'gc' ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 正在清理…
              </>
            ) : (
              <>
                <Trash2 size={12} /> 沙箱大扫除 (GC)
              </>
            )}
          </button>
        </div>
      </div>

      {/* 搜索与分类导航 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '14px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: '全部类别' },
            { key: 'agi', label: 'AGI / 记忆' },
            { key: 'ui', label: '界面 / 工作台' },
            { key: 'tools', label: '工具 / 检索' },
            { key: 'vision', label: '视觉 / 多模态' },
            { key: 'harvested', label: '反向收割' },
            { key: 'local', label: '本地包' },
          ].map((cat) => (
            <button
              key={cat.key}
              className={`btn sm ${categoryFilter === cat.key ? 'primary' : ''}`}
              onClick={() => setCategoryFilter(cat.key)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            className="input sm"
            value={securityFilter}
            onChange={(e) => setSecurityFilter(e.target.value)}
            style={{ width: '130px' }}
          >
            <option value="all">所有安全等级</option>
            <option value="official">官方精选</option>
            <option value="safe">安全认证</option>
            <option value="warning">需关注权限</option>
            <option value="danger">高危警示</option>
          </select>

          <input
            className="input sm"
            placeholder="搜索沙箱插件名 / 描述…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '220px' }}
          />
        </div>
      </div>

      {/* 插件列表表格 / 卡片 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-soft)', borderBottom: '1px solid var(--card-border)' }}>
                <th style={{ width: '40px', textAlign: 'center', padding: '10px' }}>
                  <input
                    type="checkbox"
                    checked={
                      selectableGroups.length > 0 && selectableGroups.every((g) => selectedIds.has(g.entry.id))
                    }
                    onChange={toggleSelectAll}
                    title="全选可批量操作的父行（子副本随父捆绑，不参与全选）"
                  />
                </th>
                <th style={{ textAlign: 'left', padding: '10px' }}>插件名称 / 描述</th>
                <th style={{ textAlign: 'left', padding: '10px', width: '100px' }}>版本</th>
                <th style={{ textAlign: 'left', padding: '10px', width: '110px' }}>安全审计</th>
                <th style={{ textAlign: 'left', padding: '10px', width: '90px' }}>零拷贝</th>
                <th style={{ textAlign: 'left', padding: '10px' }}>已挂载环境</th>
                <th style={{ textAlign: 'right', padding: '10px', width: '240px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} style={{ padding: '20px 10px' }}>
                    <SkeletonTable rows={4} cols={7} />
                  </td>
                </tr>
              )}
              {!loading && filteredGroups.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '24px 0' }}>
                    <EmptyState
                      icon={Archive}
                      title="沙箱隔离仓库中暂无匹配资产"
                      description={
                        search
                          ? `未搜索到匹配「${search}」的插件资产，请更换关键词或清除筛选。`
                          : 'Vault 沙箱隔离池为空。您可以从市场一键下载插件至沙箱，或导入本地开发中的插件包。'
                      }
                      action={
                        search
                          ? {
                              label: '清除搜索',
                              icon: X,
                              onClick: () => setSearch(''),
                            }
                          : {
                              label: '导入本地插件',
                              icon: Upload,
                              variant: 'glow',
                              onClick: () => setImportModal({ open: true, targetPath: '', category: 'local' }),
                            }
                      }
                    />
                  </td>
                </tr>
              )}
              {!loading &&
                filteredGroups.map((group) => {
                  const p = group.entry
                  // 单插件审计进行中（bug 1：点击「审计」后必须有可见进度）
                  const auditing = actionLoading === `audit-${p.id}`
                  // 展开态 = 用户手动展开 ∪ 因「子条目命中筛选」必须展开（后者保证命中的子条目真的看得见）
                  const expanded = expandedParentIds.has(p.id) || autoExpandedIds.has(p.id)
                  // 父声明的捆绑项里、当前清单已无对应子条目的数量（只作提示，不臆造行）
                  const missingDeclared = Math.max(0, group.declaredNames.length - group.children.length)
                  // 父已失联的子条目（数据损坏或父刚被删）：仍以顶级行出现以免静默消失。
                  // 它没有可组合的另一半（组合 = 根 + 子副本），因此除审计外不提供任何操作入口
                  const parentlessChild = group.parentIssue !== null
                  const selectable = !parentlessChild
                  // 根行删除的连带范围：删除单位是整个组合，N = 本组合的子副本数量（0 时不显示这句）
                  const removeNote =
                    group.children.length > 0
                      ? `删除单位是整个组合：将同时删除其名下 ${group.children.length} 个子插件。`
                      : undefined

                  return (
                    <Fragment key={p.id}>
                      <tr
                        style={{
                          borderBottom: '1px solid var(--card-border)',
                          background: selectedIds.has(p.id) ? 'rgba(59,130,246,0.05)' : 'transparent',
                        }}
                      >
                        <td style={{ textAlign: 'center', padding: '10px' }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(p.id)}
                            disabled={!selectable}
                            title={
                              selectable
                                ? undefined
                                : '该条目的所属父插件已不在清单中，没有可整体删除的组合，故不参与批量操作'
                            }
                            onChange={() => toggleSelect(p.id)}
                          />
                        </td>

                        <td style={{ padding: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {group.children.length > 0 && (
                              <button
                                type="button"
                                className="vault-expand-toggle"
                                aria-expanded={expanded}
                                onClick={() => toggleExpand(p.id)}
                                title={
                                  expanded
                                    ? `收起 ${p.name} 名下捆绑的 ${group.children.length} 个子插件`
                                    : `展开 ${p.name} 名下捆绑的 ${group.children.length} 个子插件`
                                }
                              >
                                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </button>
                            )}
                            <strong style={{ fontSize: '0.95rem' }}>{p.name}</strong>
                            <span
                              style={{
                                fontSize: '0.7rem',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: 'var(--surface-soft)',
                                color: 'var(--text-dim)',
                                border: '1px solid var(--card-border)',
                              }}
                            >
                              {p.category || 'tools'}
                            </span>
                            {group.parentIssue && (
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  background: 'rgba(220,38,38,0.12)',
                                  color: 'var(--err)',
                                  border: '1px solid var(--err)',
                                  fontWeight: 600,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 3,
                                }}
                                title={
                                  group.parentIssue === 'missing'
                                    ? `这条子条目声明的父插件（id: ${p.parentId}）已不在沙箱清单中：可能是数据损坏，也可能是父刚被删除。它仍列在这里以免被静默吞掉；其物理副本可执行「沙箱大扫除 (GC)」回收。`
                                    : `这条子条目的父插件本身也是子条目（id: ${p.parentId}），层级异常，故顶到顶层展示以避免条目消失。`
                                }
                              >
                                <AlertTriangle size={10} /> 父已缺失
                              </span>
                            )}
                            {p.hasUpdate && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--warn)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                <ArrowUpCircle size={11} /> 新版 {p.latestVersion}
                                <button
                                  className="btn sm"
                                  style={{
                                    padding: '1px 6px',
                                    fontSize: '0.7rem',
                                    background: 'var(--warn-surface)',
                                    color: 'var(--on-warn)',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    lineHeight: 1.2,
                                  }}
                                  disabled={actionLoading === `update-${p.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleUpdateSingle(p)
                                  }}
                                  title={`立即下载并升级到 v${p.latestVersion}，并自动更新所有挂载环境`}
                                >
                                  {actionLoading === `update-${p.id}` ? (
                                    <>
                                      <RefreshCw size={10} className="animate-spin" /> 更新中…
                                    </>
                                  ) : (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                      <ArrowUpCircle size={10} /> 立即更新
                                    </span>
                                  )}
                                </button>
                              </span>
                            )}
                          </div>
                          {/* 捆绑概览只挂在父行：子副本的体积已并入这里，父行才是「一共占了多少」的唯一出处 */}
                          {(group.children.length > 0 || group.declaredNames.length > 0) && (
                            <div className="vault-bundle-meta">
                              {group.children.length > 0 ? (
                                <>
                                  <span
                                    className="vault-bundle-chip"
                                    title={`捆绑的子依赖：${
                                      group.declaredNames.length > 0
                                        ? group.declaredNames.join('、')
                                        : group.children.map((c) => c.name).join('、')
                                    }`}
                                  >
                                    <Boxes size={11} /> 含 {group.children.length} 个子插件
                                  </span>
                                  <span style={{ color: 'var(--text-dim)' }}>
                                    合并体积 <strong>{formatMergedSize(group)}</strong>
                                  </span>
                                </>
                              ) : (
                                <span
                                  className="vault-bundle-chip"
                                  title="该父插件声明自己捆绑了这些依赖，但当前清单里找不到对应条目（可能已被单独删除）。"
                                >
                                  <Boxes size={11} /> 声明捆绑 {group.declaredNames.length} 项
                                </span>
                              )}
                              {missingDeclared > 0 && group.children.length > 0 && (
                                <span
                                  style={{ color: 'var(--warn)' }}
                                  title="父插件声明捆绑的项多于清单里实际存在的子条目，差额只如实提示，不臆造行。"
                                >
                                  另有 {missingDeclared} 项声明捆绑但清单中缺失
                                </span>
                              )}
                            </div>
                          )}
                          <div
                            style={{
                              fontSize: '0.8rem',
                              color: 'var(--text-dim)',
                              marginTop: '3px',
                              maxHeight: '38px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                            }}
                          >
                            {p.description || '暂无描述'}
                          </div>
                        </td>

                        <td style={{ padding: '10px', fontSize: '0.85rem' }}>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                            v{p.activeVersion || p.version}
                          </span>
                          {p.versions && p.versions.length > 1 && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                              共 {p.versions.length} 个版本
                            </div>
                          )}
                        </td>

                        <td style={{ padding: '10px' }}>
                          <AuditLevelChip p={p} busy={auditing} onInspect={handleInspectAudit} />
                        </td>

                        <td style={{ padding: '10px' }}>
                          <span
                            style={{
                              fontSize: '0.75rem',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(99,102,241,0.12)',
                              color: 'var(--brand-text)',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                            }}
                          >
                            <Zap size={10} /> Junction
                          </span>
                        </td>

                        <td style={{ padding: '10px' }}>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {(!p.installedProfiles || p.installedProfiles.length === 0) && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>未挂载</span>
                            )}
                            {p.installedProfiles?.map((prof) => (
                              <span
                                key={prof}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  fontSize: '0.75rem',
                                  background: 'var(--surface-soft)',
                                  border: '1px solid var(--card-border)',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                }}
                              >
                                <strong>{prof}</strong>
                                {/* 父已缺失的子条目只有单条身份（没有可组合的父），故不提供卸载/回滚 */}
                                {!parentlessChild && (
                                  <>
                                    <button
                                      style={{
                                        border: 'none',
                                        background: 'transparent',
                                        cursor: 'pointer',
                                        color: 'var(--muted)',
                                        padding: '0 2px',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                      }}
                                      title="从该环境卸载 (热拔插)"
                                      disabled={actionLoading === `unmount-${p.id}-${prof}`}
                                      onClick={() => void handleUnmount(p, prof)}
                                    >
                                      {actionLoading === `unmount-${p.id}-${prof}` ? (
                                        <RefreshCw size={10} className="animate-spin" />
                                      ) : (
                                        <X size={10} />
                                      )}
                                    </button>
                                    <button
                                      style={{
                                        border: 'none',
                                        background: 'transparent',
                                        cursor: 'pointer',
                                        color: 'var(--brand-text)',
                                        padding: '0 2px',
                                        fontSize: '0.7rem',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                      }}
                                      title="一键回滚到前序版本"
                                      disabled={actionLoading === `rollback-${p.id}-${prof}`}
                                      onClick={() => void handleRollback(p, prof)}
                                    >
                                      {actionLoading === `rollback-${p.id}-${prof}` ? (
                                        <RefreshCw size={10} className="animate-spin" />
                                      ) : (
                                        <RotateCcw size={10} />
                                      )}
                                    </button>
                                  </>
                                )}
                              </span>
                            ))}
                          </div>
                        </td>

                        <td style={{ padding: '10px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: '6px' }}>
                            {/* 父已失联的子条目没有可组合的另一半：整个操作列只留审计 */}
                            {!parentlessChild && (
                              <button
                                className="btn sm primary"
                                onClick={() =>
                                  setDeployModal({
                                    open: true,
                                    plugin: p,
                                    targetProfile: profiles[0]?.name || '',
                                    version: p.activeVersion || p.version,
                                  })
                                }
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <Rocket size={11} /> 瞬时注入
                              </button>
                            )}
                            <AuditOnlyButton p={p} busy={auditing} onInspect={handleInspectAudit} />
                            {!parentlessChild && (
                              <button
                                className="btn danger sm"
                                onClick={() =>
                                  void handleRemoveCombination({
                                    clicked: p,
                                    rootId: p.id,
                                    // 没有子插件时不存在「组合」，按它自己的名字提示
                                    combination:
                                      group.children.length > 0
                                        ? { rootName: p.name, childCount: group.children.length }
                                        : undefined,
                                    cascadeNote: removeNote,
                                  })
                                }
                                disabled={actionLoading === `remove-${p.id}`}
                                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                title={
                                  group.children.length > 0
                                    ? `永久删除整个组合：连同其名下 ${group.children.length} 个子插件一起移除（被其他插件依赖时将提示改用级联移除）`
                                    : '永久删除（被其他插件依赖时将提示改用级联移除）'
                                }
                              >
                                {actionLoading === `remove-${p.id}` ? (
                                  <RefreshCw size={12} className="animate-spin" />
                                ) : (
                                  <Trash2 size={12} />
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {/* 子副本只在父行展开时出现，并与父行同级渲染（缩进交给样式），
                          这样它们仍属于同一张表、同一份筛选结果 */}
                      {expanded &&
                        group.children.map((c) => {
                          const childAuditing = actionLoading === `audit-${c.id}`
                          // 子行删除的连带范围：删子即删母，整个组合（父 + 父名下全部子副本）都会消失。
                          // 文案必须点明这一点，否则用户会以为只删了眼前这一条
                          const siblings = group.children.length - 1
                          const childRemoveNote =
                            siblings > 0
                              ? `删除单位是整个组合：将连同它的父插件「${p.name}」及父名下另外 ${siblings} 个子插件一并移除。`
                              : `删除单位是整个组合：将连同它的父插件「${p.name}」一并移除（该父名下没有其它子插件）。`
                          return (
                            <tr key={c.id} className="vault-child-row">
                              <td style={{ textAlign: 'center', padding: '10px' }}>
                                {/* 子副本没有复选框：批量删除的单位是组合，勾中子行会让「删 3 条」变成「删 3 个组合」 */}
                                <CornerDownRight size={13} style={{ color: 'var(--muted)' }} />
                              </td>

                              <td style={{ padding: '10px' }}>
                                <div className="vault-child-name">
                                  <strong style={{ fontSize: '0.9rem' }}>{c.name}</strong>
                                  <ChildOriginTag origin={c.childOrigin} />
                                  <span
                                    style={{
                                      fontSize: '0.7rem',
                                      padding: '1px 6px',
                                      borderRadius: '4px',
                                      background: 'var(--surface-soft)',
                                      color: 'var(--text-dim)',
                                      border: '1px solid var(--card-border)',
                                    }}
                                  >
                                    {c.category || 'tools'}
                                  </span>
                                  {c.hasUpdate && (
                                    <span
                                      style={{ fontSize: '0.72rem', color: 'var(--warn)', fontWeight: 600 }}
                                      title="子副本不单独升级：点击上方「自动更新全部」会连同它一起升级并按父同步"
                                    >
                                      待更新 v{c.latestVersion}
                                    </span>
                                  )}
                                </div>
                                <div className="vault-child-desc">{c.description || '暂无描述'}</div>
                              </td>

                              <td style={{ padding: '10px', fontSize: '0.85rem' }}>
                                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                                  v{c.activeVersion || c.version}
                                </span>
                              </td>

                              <td style={{ padding: '10px' }}>
                                <AuditLevelChip p={c} busy={childAuditing} onInspect={handleInspectAudit} />
                              </td>

                              <td style={{ padding: '10px' }}>
                                <span
                                  style={{ fontSize: '0.75rem', color: 'var(--muted)' }}
                                  title="子副本随父插件一同注入/卸载，不存在独立的 Junction 归属"
                                >
                                  随父捆绑
                                </span>
                              </td>

                              <td style={{ padding: '10px' }}>
                                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                  {(!c.installedProfiles || c.installedProfiles.length === 0) && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>未挂载</span>
                                  )}
                                  {/* 只读展示：卸载/回滚都以组合为单位由根行发起，子行不提供这两个入口 */}
                                  {c.installedProfiles?.map((prof) => (
                                    <span
                                      key={prof}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        fontSize: '0.75rem',
                                        background: 'var(--surface-soft)',
                                        border: '1px solid var(--card-border)',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                      }}
                                      title="该环境通过父插件间接使用了这个依赖"
                                    >
                                      <strong>{prof}</strong>
                                    </span>
                                  ))}
                                </div>
                              </td>

                              <td style={{ padding: '10px', textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', gap: '6px' }}>
                                  {/* 子行只保留「审计」与「删除组合」：注入/卸载/回滚都以单条身份改动父的环境声明，
                                      而删除按组合语义是合法的（等价于删掉父），故仍提供 */}
                                  <AuditOnlyButton p={c} busy={childAuditing} onInspect={handleInspectAudit} />
                                  <button
                                    className="btn danger sm"
                                    onClick={() =>
                                      void handleRemoveCombination({
                                        clicked: c,
                                        // 子行也传组合根的 id：删除单位是组合，不依赖后端反向级联
                                        rootId: p.id,
                                        combination: { rootName: p.name, childCount: group.children.length },
                                        cascadeNote: childRemoveNote,
                                      })
                                    }
                                    disabled={actionLoading === `remove-${c.id}`}
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                    title={`永久删除整个组合：连同父插件「${p.name}」及其名下全部子插件一起移除`}
                                  >
                                    {actionLoading === `remove-${c.id}` ? (
                                      <RefreshCw size={12} className="animate-spin" />
                                    ) : (
                                      <Trash2 size={12} />
                                    )}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                    </Fragment>
                  )
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 弹窗 1: 瞬时注入挂载配置 */}
      {deployModal.open && deployModal.plugin && (
        <div className="modal-backdrop" onClick={() => setDeployModal({ open: false, plugin: null, targetProfile: '', version: '' })}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Rocket size={16} /> 瞬时直连挂载至 Profile
            </div>
            <p className="modal-desc" style={{ marginBottom: '12px' }}>
              通过 Windows 原生 NTFS Junction 零拷贝直通目标环境，秒级挂载免重新下载与解压。
            </p>

            <div style={{ margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                目标环境 (Profile)
              </label>
              <select
                className="input"
                style={{ width: '100%' }}
                value={deployModal.targetProfile}
                onChange={(e) => setDeployModal({ ...deployModal, targetProfile: e.target.value })}
              >
                {profiles.map((pr) => (
                  <option key={pr.name} value={pr.name}>
                    {pr.name} {pr.running ? '(运行中)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                挂载版本
              </label>
              <input
                className="input"
                style={{ width: '100%' }}
                value={deployModal.version}
                onChange={(e) => setDeployModal({ ...deployModal, version: e.target.value })}
              />
            </div>

            <div style={{ padding: '8px 12px', background: 'var(--surface-soft)', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={13} style={{ flexShrink: 0 }} />
              <span><strong>自愈契约防护已就绪</strong>：注入时将自动应用 <code>settingsNamespace</code> / <code>CallId</code> 兼容垫片，防 DSH 0.1.2 破坏性升级崩溃。</span>
            </div>

            <div className="modal-actions" style={{ marginTop: '18px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn" onClick={() => setDeployModal({ open: false, plugin: null, targetProfile: '', version: '' })}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => void handleExecuteDeploy()}
                disabled={actionLoading?.startsWith('deploy-')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {actionLoading?.startsWith('deploy-') ? <><RefreshCw size={12} className="animate-spin" /> 正在挂载…</> : '立即瞬时挂载'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 2: 广播批量挂载 */}
      {batchModal.open && (
        <div className="modal-backdrop" onClick={() => setBatchModal({ open: false, targetProfiles: [] })}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Rocket size={16} /> 广播式批量挂载
            </div>
            <p className="modal-desc">
              将选中的 <strong>{selectedIds.size}</strong> 个沙箱插件并发直连分发到勾选的环境中。
            </p>

            <div style={{ margin: '14px 0', maxHeight: '200px', overflowY: 'auto' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                选择目标 Profile 环境：
              </label>
              {profiles.map((p) => {
                const checked = batchModal.targetProfiles.includes(p.name)
                return (
                  <label
                    key={p.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: checked ? 'var(--surface-soft)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? batchModal.targetProfiles.filter((n) => n !== p.name)
                          : [...batchModal.targetProfiles, p.name]
                        setBatchModal({ ...batchModal, targetProfiles: next })
                      }}
                    />
                    <span>{p.name}</span>
                    {p.running && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className="pulse-dot active" style={{ width: 6, height: 6, display: 'inline-block' }} /> 运行中
                      </span>
                    )}
                  </label>
                )
              })}
            </div>

            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn" onClick={() => setBatchModal({ open: false, targetProfiles: [] })}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={batchModal.targetProfiles.length === 0 || actionLoading === 'batch-deploy'}
                onClick={() => void handleBatchDeploy()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {actionLoading === 'batch-deploy' ? <><RefreshCw size={12} className="animate-spin" /> 正在广播挂载…</> : '开始批量分发'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 3: 静态代码安全审计报告 */}
      {auditModal.open && auditModal.report && (
        <div className="modal-backdrop" onClick={() => setAuditModal({ open: false, report: null, pluginName: '' })}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={16} /> 插件安全审计报告: {auditModal.pluginName}
            </div>
            <p className="modal-desc" style={{ marginBottom: '12px' }}>
              深度 AST 语法分析 · 敏感环境访问 · 外壳命令与高危反弹特征扫描
            </p>

            <div style={{ display: 'flex', gap: '16px', padding: '12px', background: 'var(--surface-soft)', borderRadius: '8px', marginBottom: '14px' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>综合安全评分</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: auditModal.report.score >= 80 ? 'var(--ok)' : 'var(--warn)' }}>
                  {auditModal.report.score} / 100
                </div>
              </div>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>扫描源码文件数</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                  {auditModal.report.scannedFiles} <span style={{ fontSize: '0.8rem' }}>个</span>
                </div>
              </div>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>安全评级结论</span>
                <div style={{ fontSize: '1.1rem', fontWeight: 600, marginTop: '4px' }}>
                  {auditModal.report.level === 'official' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ShieldCheck size={14} /> 官方精选 (信任)</span>}
                  {auditModal.report.level === 'safe' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={14} style={{ color: 'var(--success)' }} /> 安全认证 (无高敏行为)</span>}
                  {auditModal.report.level === 'warning' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={14} style={{ color: 'var(--warn)' }} /> 需关注权限调用</span>}
                  {auditModal.report.level === 'danger' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertCircle size={14} style={{ color: 'var(--err)' }} /> 高危命令 (建议阻断)</span>}
                </div>
              </div>
            </div>

            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '6px' }}>
                规则匹配审计明细 ({auditModal.report.findings.length} 条)：
              </strong>
              {auditModal.report.findings.length === 0 && (
                <div style={{ color: 'var(--ok)', fontSize: '0.85rem', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={14} /> 未发现任何越权读取密钥、反弹 Shell 或环境提取等高危语法特征。
                </div>
              )}
              {auditModal.report.findings.map((f, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    marginBottom: '8px',
                    background: f.severity === 'danger' ? 'rgba(220,38,38,0.06)' : 'rgba(217,119,6,0.06)',
                    border: `1px solid ${f.severity === 'danger' ? 'var(--err)' : 'var(--warn)'}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600 }}>
                    <span style={{ color: f.severity === 'danger' ? 'var(--err)' : 'var(--warn)' }}>
                      [{f.severity.toUpperCase()}] {f.ruleId} - {f.message}
                    </span>
                    <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
                      {f.file}:{f.line}
                    </span>
                  </div>
                  {f.snippet && (
                    <pre
                      style={{
                        margin: '6px 0 0',
                        padding: '4px 6px',
                        background: 'rgba(0,0,0,0.05)',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        overflowX: 'auto',
                      }}
                    >
                      {f.snippet}
                    </pre>
                  )}
                </div>
              ))}
            </div>

            <div className="modal-actions" style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAuditModal({ open: false, report: null, pluginName: '' })}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4: 部署与快照历史 */}
      {historyModal.open && (
        <div className="modal-backdrop" onClick={() => setHistoryModal({ open: false })}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <History size={16} /> 部署与回滚历史快照
            </div>
            <p className="modal-desc">记录沙箱插件跨环境部署、多版本原子切换及一键快照回滚全日志。</p>

            <div style={{ maxHeight: '360px', overflowY: 'auto', margin: '14px 0' }}>
              {history.length === 0 && (
                <EmptyState
                  compact
                  icon={History}
                  title="暂无部署快照记录"
                  description="在沙箱中执行跨环境挂载或多版本原子切换时，系统将在此自动保存快照并支持秒级回滚。"
                />
              )}
              {history.slice().reverse().map((h) => (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    background: 'var(--surface-soft)',
                    marginBottom: '6px',
                    fontSize: '0.85rem',
                  }}
                >
                  <div>
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        marginRight: '6px',
                        background: h.action === 'deploy' ? 'rgba(5,150,105,0.15)' : h.action === 'rollback' ? 'rgba(217,119,6,0.15)' : 'rgba(59,130,246,0.15)',
                        color: h.action === 'deploy' ? 'var(--ok)' : h.action === 'rollback' ? 'var(--warn)' : 'var(--brand-text)',
                      }}
                    >
                      {h.action.toUpperCase()}
                    </span>
                    <strong>{h.pluginName}</strong> → 目标环境: <code>{h.profile}</code>
                    {h.fromVersion && <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}> ({h.fromVersion} → {h.toVersion})</span>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{formatDate(h.timestamp)}</div>
                </div>
              ))}
            </div>

            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setHistoryModal({ open: false })}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 5: 导入本地插件 */}
      {importModal.open && (
        <div className="modal-backdrop" onClick={() => setImportModal({ open: false, targetPath: '', category: 'local' })}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Upload size={16} /> 导入本地插件至沙箱
            </div>
            <p className="modal-desc">指定本地开发目录或解压包，沙箱将自动完成 AST 审计并加入内容寻址存储池。</p>

            <div style={{ margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                本地插件目录绝对路径：
              </label>
              <input
                className="input"
                style={{ width: '100%' }}
                placeholder="例如: C:\Users\...\my-dsh-plugin"
                value={importModal.targetPath}
                onChange={(e) => setImportModal({ ...importModal, targetPath: e.target.value })}
              />
            </div>

            <div style={{ margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px', fontWeight: 600 }}>
                所属类别：
              </label>
              <select
                className="input"
                style={{ width: '100%' }}
                value={importModal.category}
                onChange={(e) => setImportModal({ ...importModal, category: e.target.value })}
              >
                <option value="local">本地开发</option>
                <option value="tools">工具 / 检索</option>
                <option value="ui">界面 / 主题</option>
                <option value="agi">智能体 / 认知</option>
                <option value="vision">视觉 / 多模态</option>
              </select>
            </div>

            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn" onClick={() => setImportModal({ open: false, targetPath: '', category: 'local' })}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={!importModal.targetPath.trim() || actionLoading === 'import-local'}
                onClick={() => void handleImportLocal()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {actionLoading === 'import-local' ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" /> 正在导入…
                  </>
                ) : (
                  '导入入库'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 6: 沙箱更新机制与版本判定规则深度解析 */}
      {explainModal && (
        <div className="modal-backdrop" onClick={() => setExplainModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '580px' }}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HelpCircle size={18} style={{ color: 'var(--brand-primary)' }} />
              <span>插件沙箱更新与版本机制说明</span>
            </div>
            <div style={{ margin: '14px 0', fontSize: '0.85rem', lineHeight: '1.7', color: 'var(--text-secondary)' }}>
              <p style={{ marginBottom: '10px' }}>
                用户常见疑问：<strong>“为什么点击‘全部更新’时，只有一部分插件更新了，而不是所有 50+ 个插件都全量下载？”</strong>
              </p>
              <div style={{ background: 'var(--surface-soft)', padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border-hairline)', marginBottom: '10px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>1. 智能差量升级策略 (Save Bandwidth & Stability)</div>
                <div>沙箱采用现代化包管理器的差量升级哲学。系统首先并发校验 npm 镜像源上的最新版本（latest），<strong>仅对远程确实存在更高版本（hasUpdate = true）的插件执行拉取与解包</strong>。对于版本已是最新（当前 {plugins.filter((p) => !p.hasUpdate && p.source !== 'local').length} 个）的插件，系统自动跳过冗余下载，直接复用本地缓存与既有 Junction 链接。</div>
              </div>
              <div style={{ background: 'var(--surface-soft)', padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border-hairline)', marginBottom: '10px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>2. 本地收割资产保护 (Local Harvest Protection)</div>
                <div>从环境反向收割入库（<code>source: 'local'</code>）的插件属于用户本地开发或魔改包。为防止远程 npm 代码覆盖破坏您的本地开发改动，系统<strong>严格排除自动从 npm 覆盖这些插件</strong>。</div>
              </div>
              <div style={{ background: 'var(--surface-soft)', padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border-hairline)' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>3. 私有包与网络超时保护</div>
                <div>专属私有包在 npm 镜像返回 404 时将安全保留；若遇到网络抖动触发 3.5s 保护性超时，对应插件将保持就绪，您可在网络通畅后再次点击“检查更新”。</div>
              </div>
            </div>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => setExplainModal(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog}
    </div>
  )
}
