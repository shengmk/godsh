import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Zap,
  ExternalLink,
  Box,
  Layers,
  ShoppingBag,
  Binary,
  Settings,
  RefreshCw,
} from 'lucide-react'
import { api } from '../api'
import type { Allocation, DshStatus, KernelInstance, KernelTemplate, LocalPlugin, ProfileView } from '../types'
import { Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'
import { usePageRefresh } from '../refresh'
import { openDshWeb } from '../tauri'

type PageKey = 'console' | 'profiles' | 'market' | 'allocations' | 'kernels' | 'dsh-envs' | 'settings'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Phase = 'idle' | 'installing' | 'initing' | 'starting' | 'done' | 'error'

export default function ControllerConsolePage({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null)
  const [plugins, setPlugins] = useState<LocalPlugin[] | null>(null)
  const [kernels, setKernels] = useState<{ templates: KernelTemplate[]; instances: KernelInstance[] } | null>(null)
  const [allocations, setAllocations] = useState<Allocation[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [phaseMsg, setPhaseMsg] = useState('')
  const [startedUrl, setStartedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloading, setReloading] = useState(false)
  // 指标卡加载失败不再静默（bug 1）：原来是 .catch(() => {})，失败后骨架屏永久停留
  const [loadError, setLoadError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const { toast } = useToast()
  const { t } = useI18n()

  async function load() {
    const fail = (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e))
    setLoadError(null)

    // 1. 本地高速数据：完全解耦独立并发加载，毫秒级直接呈现
    void api.profiles().then(setProfiles).catch(fail)
    void api.plugins().then(setPlugins).catch(fail)
    void api.kernels().then(setKernels).catch(fail)
    void api.allocations().then(setAllocations).catch(fail)

    // 2. DSH 状态与版本检测：异步到达，不阻断其他卡片加载
    try {
      const s = await api.dshStatus()
      setStatus(s)
    } catch (e) {
      fail(e)
    }
  }

  /** 手动刷新（顶栏全局刷新按钮与页面按钮复用同一份 load 逻辑） */
  async function handleReload() {
    if (reloading) return
    setReloading(true)
    try {
      await load()
    } finally {
      setReloading(false)
    }
  }

  /** 轮询认证地址：直到拿到带 token 的 url 或超时（bug 6：绝不使用无 token 的地址） */
  async function waitForAuthUrl(name: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(700)
      try {
        const statuses = await api.profilesStatus([name])
        const u = statuses[name]?.url ?? null
        if (u && /[?&]token=/.test(u)) return u
      } catch {
        /* 轮询失败继续尝试 */
      }
    }
    return null
  }

  usePageRefresh(handleReload, 'console')

  useEffect(() => {
    void load()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  // 有后台安装任务时每 2s 刷新状态
  useEffect(() => {
    if (status?.tasks.some((x) => x.status === 'running')) {
      if (pollTimer.current) clearInterval(pollTimer.current)
      pollTimer.current = setInterval(() => void api.dshStatus().then(setStatus).catch(() => {}), 2000)
    } else if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [status])

  /** 一键快速启动默认模板：无 dsh → 安装 base → 初始化模板 → 启动默认环境 */
  async function quickStart() {
    if (busy) return
    setBusy(true)
    setStartedUrl(null)
    try {
      setPhase('installing')
      setPhaseMsg('检查 dsh…')
      let st = await api.dshStatus()
      if (!st.found) {
        await api.dshInstall()
        setPhaseMsg('正在安装官方 dsh（npm），请稍候…')
        for (let i = 0; i < 150; i++) {
          await sleep(2000)
          st = await api.dshStatus()
          if (st.found && !st.tasks.some((x) => x.status === 'running')) break
        }
        if (!st.found) throw new Error('dsh 安装失败，请查看「DSH 环境」页日志')
      }
      setPhase('initing')
      setPhaseMsg('初始化 DSH_HOME 与官方默认模板…')
      const init = await api.dshInitHome()
      setPhaseMsg(`就绪：${init.home}`)
      setPhase('starting')
      setPhaseMsg('启动默认环境 web…')
      const r = await api.startProfile('web', { waitMs: 15000 })
      let url = r.url && /[?&]token=/.test(r.url) ? r.url : null
      if (!url) {
        // url 为 null = 认证地址还没生成；绝不用 `http://127.0.0.1:${port}` 兜底（无 token 必然 401）
        setPhaseMsg('环境已启动，正在获取认证地址…')
        url = await waitForAuthUrl('web', 30000)
      }
      if (!url) {
        throw new Error('环境已启动，但认证地址仍未就绪。请稍后到「DSH 环境」页打开该环境（不带 token 的地址会返回 401）')
      }
      setStartedUrl(url)
      setPhase('done')
      setPhaseMsg('默认模板已启动')
      void load()
    } catch (e) {
      setPhase('error')
      setPhaseMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const running = (profiles ?? []).filter((p) => p.running).length
  const hasInstallTask = status?.tasks.some((x) => x.status === 'running') ?? false
  /** 只有带 token 的地址才是可用的 dsh web 认证地址 */
  const openUrl = startedUrl && /[?&]token=/.test(startedUrl) ? startedUrl : null

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">{t('page.console.title')}</h1>
          <p className="page-desc">{t('page.console.desc')}</p>
        </div>
        <button
          className="btn sm"
          disabled={reloading}
          onClick={() => void handleReload()}
          title="重新加载控制台数据"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={13} className={reloading ? 'animate-spin' : ''} />
          {reloading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {loadError && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(239, 68, 68, 0.5)' }}>
          <div className="card-title" style={{ color: 'var(--err)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} /> 指标卡加载失败
          </div>
          <p className="muted">{loadError}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" disabled={reloading} onClick={() => void handleReload()}>
              重试
            </button>
          </div>
        </div>
      )}

      {status && !status.found && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(245, 158, 11, 0.5)' }}>
          <div className="card-title" style={{ color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} /> {t('console.noDsh')}
          </div>
          <p className="muted">{t('console.noDshHint')}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('console.quickStart')}</div>
        <p className="card-sub">{t('console.quickStartHint')}</p>
        {phase !== 'idle' && phase !== 'done' && (
          <p className="muted" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="pulse-dot active" style={{ width: 6, height: 6, display: 'inline-block' }} />
            {phase === 'installing' ? '① ' : phase === 'initing' ? '② ' : '③ '}
            {phaseMsg}
            {hasInstallTask ? '（安装进行中…）' : ''}
          </p>
        )}
        {phase === 'done' && startedUrl && (
          <p className="muted" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> {t('console.ready')}：{startedUrl}
          </p>
        )}
        {phase === 'done' && startedUrl && !openUrl && (
          <p className="muted" style={{ marginBottom: 8, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} /> 认证地址尚未就绪，请稍后到「DSH 环境」页打开该环境
          </p>
        )}
        {phase === 'error' && (
          <p className="muted" style={{ marginBottom: 8, color: 'var(--err)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} /> {phaseMsg}
          </p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary btn-glow-primary" disabled={busy} onClick={() => void quickStart()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Zap size={13} /> {busy ? '…' : t('console.quickStartBtn')}
          </button>
          {openUrl && (
            <button className="btn" onClick={() => void openDshWeb(openUrl)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('console.open')} <ExternalLink size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <div className="card dash-card">
          <div className="dash-value">
            {status === null ? (
              <span className="skeleton-box" style={{ width: 68, height: 28 }} />
            ) : status.found ? (
              status.currentVersion ?? '?'
            ) : (
              '未安装'
            )}
          </div>
          <div className="dash-label">
            {t('dash.dshVersion')}
            {status && status.detectedCount > 1 ? `（共 ${status.detectedCount} 个）` : ''}
          </div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">
            {profiles === null ? <span className="skeleton-box" style={{ width: 36, height: 28 }} /> : profiles.length}
          </div>
          <div className="dash-label">{t('dash.profiles')}</div>
        </div>
        <div className="card dash-card accent">
          <div className="dash-value">
            {profiles === null ? <span className="skeleton-box" style={{ width: 36, height: 28 }} /> : running}
          </div>
          <div className="dash-label">{t('dash.running')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">
            {plugins === null ? <span className="skeleton-box" style={{ width: 36, height: 28 }} /> : plugins.length}
          </div>
          <div className="dash-label">{t('dash.plugins')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">
            {kernels === null ? <span className="skeleton-box" style={{ width: 36, height: 28 }} /> : kernels.instances.length}
          </div>
          <div className="dash-label">{t('dash.kernels')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">
            {allocations === null ? <span className="skeleton-box" style={{ width: 36, height: 28 }} /> : allocations.length}
          </div>
          <div className="dash-label">{t('dash.allocations')}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title">{t('dash.quick')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          {[
            { label: t('console.goEnvs'), key: 'dsh-envs' as PageKey, icon: Box },
            { label: t('dash.quickProfiles'), key: 'profiles' as PageKey, icon: Layers },
            { label: t('dash.quickMarket'), key: 'market' as PageKey, icon: ShoppingBag },
            { label: t('dash.quickKernels'), key: 'kernels' as PageKey, icon: Binary },
            { label: t('dash.quickSettings'), key: 'settings' as PageKey, icon: Settings },
          ].map((q) => {
            const Icon = q.icon
            return (
              <button
                key={q.key}
                className="btn"
                onClick={() => onNavigate(q.key)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Icon size={13} />
                {q.label}
              </button>
            )
          })}
        </div>
      </div>

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
