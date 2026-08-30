import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Allocation, DshStatus, KernelInstance, KernelTemplate, LocalPlugin, ProfileView } from '../types'
import { Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'
import { openDshUrl } from '../tauri'

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
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  async function load() {
    try {
      const [s, p, pl, k, a] = await Promise.all([
        api.dshStatus(),
        api.profiles(),
        api.plugins(),
        api.kernels(),
        api.allocations(),
      ])
      setStatus(s)
      setProfiles(p)
      setPlugins(pl)
      setKernels(k)
      setAllocations(a)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

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
      const r = await api.startProfile('web')
      setStartedUrl(`http://127.0.0.1:${r.port}`)
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

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.console.title')}</h1>
        <p className="page-desc">{t('page.console.desc')}</p>
      </div>

      {status && !status.found && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(245, 158, 11, 0.5)' }}>
          <div className="card-title" style={{ color: 'var(--warn)' }}>
            ⚠ {t('console.noDsh')}
          </div>
          <p className="muted">{t('console.noDshHint')}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('console.quickStart')}</div>
        <p className="card-sub">{t('console.quickStartHint')}</p>
        {phase !== 'idle' && phase !== 'done' && (
          <p className="muted" style={{ marginBottom: 8 }}>
            {phase === 'installing' ? '① ' : phase === 'initing' ? '② ' : '③ '}
            {phaseMsg}
            {hasInstallTask ? '（安装进行中…）' : ''}
          </p>
        )}
        {phase === 'done' && startedUrl && (
          <p className="muted" style={{ marginBottom: 8 }}>
            ✅ {t('console.ready')}：{startedUrl}
          </p>
        )}
        {phase === 'error' && (
          <p className="muted" style={{ marginBottom: 8, color: 'var(--err)' }}>
            ⚠ {phaseMsg}
          </p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy} onClick={() => void quickStart()}>
            {busy ? '…' : t('console.quickStartBtn')}
          </button>
          {startedUrl && (
            <button className="btn" onClick={() => void openDshUrl(startedUrl, 'dsh')}>
              {t('console.open')} ↗
            </button>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <div className="card dash-card">
          <div className="dash-value">{status?.found ? status.currentVersion ?? '?' : '—'}</div>
          <div className="dash-label">
            {t('dash.dshVersion')}
            {status && status.detectedCount > 1 ? `（共 ${status.detectedCount} 个）` : ''}
          </div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">{profiles === null ? '…' : profiles.length}</div>
          <div className="dash-label">{t('dash.profiles')}</div>
        </div>
        <div className="card dash-card accent">
          <div className="dash-value">{profiles === null ? '…' : running}</div>
          <div className="dash-label">{t('dash.running')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">{plugins === null ? '…' : plugins.length}</div>
          <div className="dash-label">{t('dash.plugins')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">{kernels === null ? '…' : kernels.instances.length}</div>
          <div className="dash-label">{t('dash.kernels')}</div>
        </div>
        <div className="card dash-card">
          <div className="dash-value">{allocations === null ? '…' : allocations.length}</div>
          <div className="dash-label">{t('dash.allocations')}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title">{t('dash.quick')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          {[
            { label: t('console.goEnvs'), key: 'dsh-envs' as PageKey },
            { label: t('dash.quickProfiles'), key: 'profiles' as PageKey },
            { label: t('dash.quickMarket'), key: 'market' as PageKey },
            { label: t('dash.quickKernels'), key: 'kernels' as PageKey },
            { label: t('dash.quickSettings'), key: 'settings' as PageKey },
          ].map((q) => (
            <button key={q.key} className="btn" onClick={() => onNavigate(q.key)}>
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
