import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Allocation, Health, KernelInstance, KernelTemplate, LocalPlugin, ProfileView } from '../types'
import { ErrorText, Loading, Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

type PageKey = 'dashboard' | 'profiles' | 'market' | 'allocations' | 'kernels' | 'settings'

export default function DashboardPage({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null)
  const [plugins, setPlugins] = useState<LocalPlugin[] | null>(null)
  const [kernels, setKernels] = useState<{ templates: KernelTemplate[]; instances: KernelInstance[] } | null>(null)
  const [allocations, setAllocations] = useState<Allocation[] | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  async function load() {
    void api.profiles().then(setProfiles).catch(() => {})
    void api.plugins().then(setPlugins).catch(() => {})
    void api.kernels().then(setKernels).catch(() => {})
    void api.allocations().then(setAllocations).catch(() => {})
    try {
      const h = await api.health()
      setHealth(h)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  useEffect(() => {
    void load()
    // 仅页面可见时轮询（后台标签页暂停，省资源）
    let visible = true
    const tick = () => {
      if (document.visibilityState === 'visible') void api.profiles().then(setProfiles).catch(() => {})
    }
    const timer = setInterval(tick, 5000)
    const onVis = () => {
      const wasHidden = !visible
      visible = document.visibilityState === 'visible'
      if (wasHidden && visible) void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const running = (profiles ?? []).filter((p) => p.running).length

  const stats: { label: string; value: number | string; accent?: boolean }[] = [
    { label: t('dash.profiles'), value: profiles === null ? '…' : profiles.length },
    { label: t('dash.running'), value: profiles === null ? '…' : running, accent: running > 0 },
    { label: t('dash.plugins'), value: plugins === null ? '…' : plugins.length },
    { label: t('dash.kernels'), value: kernels === null ? '…' : kernels.instances.length },
    { label: t('dash.allocations'), value: allocations === null ? '…' : allocations.length },
  ]

  const quick: { label: string; key: PageKey }[] = [
    { label: t('dash.quickProfiles'), key: 'profiles' },
    { label: t('dash.quickMarket'), key: 'market' },
    { label: t('dash.quickKernels'), key: 'kernels' },
    { label: t('dash.quickSettings'), key: 'settings' },
  ]

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.dashboard.title')}</h1>
        <p className="page-desc">
          {health
            ? `DSH ${health.dsh.version ?? ''} · node ${health.node.version ?? ''} · pnpm ${health.pnpm.version ?? ''} · ${health.profilesDir}`
            : t('dash.loading')}
        </p>
      </div>

      {profiles === null ? (
        <Loading />
      ) : (
        <>
          <div className="dash-grid">
            {stats.map((s) => (
              <div className={`card dash-card${s.accent ? ' accent' : ''}`} key={s.label}>
                <div className="dash-value">{s.value}</div>
                <div className="dash-label">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-title">{t('dash.quick')}</div>
            <div className="row" style={{ marginTop: 10 }}>
              {quick.map((q) => (
                <button key={q.key} className="btn primary" onClick={() => onNavigate(q.key)}>
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {health && health.errors.length > 0 && (
            <div className="card" style={{ marginTop: 18 }}>
              <ErrorText message={health.errors.join('；')} />
            </div>
          )}
        </>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
