import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Health, DshStatus, KernelInstance, LocalPlugin, ProfileView } from './types'
import { useI18n } from './i18n'
import { useTheme } from './theme'

// 按页代码分割：首屏只加载当前页面，其它页面按需加载
const ControllerConsolePage = lazy(() => import('./pages/ControllerConsolePage'))
const ProfilesPage = lazy(() => import('./pages/ProfilesPage'))
const MarketPage = lazy(() => import('./pages/MarketPage'))
const AllocationsPage = lazy(() => import('./pages/AllocationsPage'))
const KernelsPage = lazy(() => import('./pages/KernelsPage'))
const DshEnvsPage = lazy(() => import('./pages/DshEnvsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

type PageKey = 'console' | 'profiles' | 'market' | 'allocations' | 'kernels' | 'dsh-envs' | 'settings'

const NAV: { key: PageKey; labelKey: string; descKey: string }[] = [
  { key: 'console', labelKey: 'nav.console', descKey: 'nav.consoleDesc' },
  { key: 'profiles', labelKey: 'nav.profiles', descKey: 'nav.profilesDesc' },
  { key: 'market', labelKey: 'nav.market', descKey: 'nav.marketDesc' },
  { key: 'allocations', labelKey: 'nav.allocations', descKey: 'nav.allocationsDesc' },
  { key: 'kernels', labelKey: 'nav.kernels', descKey: 'nav.kernelsDesc' },
  { key: 'dsh-envs', labelKey: 'nav.dshEnvs', descKey: 'nav.dshEnvsDesc' },
  { key: 'settings', labelKey: 'nav.settings', descKey: 'nav.settingsDesc' },
]

export default function App() {
  const [page, setPage] = useState<PageKey>('console')
  const { t, locale, changeLocale } = useI18n()
  const { theme, changeTheme } = useTheme()

  // 顶栏：dsh 版本（实际激活 + 来源）+ 全局搜索
  const [health, setHealth] = useState<Health | null>(null)
  const [dshStatus, setDshStatus] = useState<DshStatus | null>(null)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchData, setSearchData] = useState<{
    profiles: ProfileView[]
    plugins: LocalPlugin[]
    kernels: KernelInstance[]
  } | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void api.health().then(setHealth).catch(() => {})
    void api.dshStatus().then(setDshStatus).catch(() => {})
  }, [])

  async function runSearch(q: string) {
    setSearch(q)
    if (!q.trim()) {
      setSearchOpen(false)
      return
    }
    // 防抖 300ms：输入期间不重复请求（避免每次击键打 profiles+plugins+kernels 3 个接口）
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      try {
        const [p, pl, k] = await Promise.all([api.profiles(), api.plugins(), api.kernels()])
        setSearchData({ profiles: p, plugins: pl, kernels: k.instances })
        setSearchOpen(true)
      } catch {
        setSearchOpen(false)
      }
    }, 300)
  }

  async function quickStart(name: string) {
    try {
      await api.startProfile(name)
      setSearch('')
      setSearchOpen(false)
    } catch (e) {
      setSearchOpen(false)
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  const q = search.trim().toLowerCase()
  const match = (s: string) => s.toLowerCase().includes(q)
  const resultProfiles = searchData ? searchData.profiles.filter((p) => match(p.name)) : []
  const resultPlugins = searchData ? searchData.plugins.filter((p) => match(p.name)) : []
  const resultKernels = searchData ? searchData.kernels.filter((k) => match(k.name)) : []
  const hasResults = resultProfiles.length + resultPlugins.length + resultKernels.length > 0

  // 版本显示：优先当前实际使用的 DSH 环境版本，否则 PATH dsh
  const shownVersion = dshStatus?.currentVersion ?? health?.dsh.version ?? ''
  const shownVersionHint = dshStatus?.activeVersionName ? `env: ${dshStatus.activeVersionName}` : 'PATH dsh'

  // 键盘快捷键：Ctrl/Alt + 1..7（不在输入框内拦截；不显示数字角标）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return
      const n = Number(e.key)
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault()
        setPage(NAV[n - 1]!.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">d</div>
          <div>
            <div className="brand-name">{t('app.name')}</div>
            <div className="brand-sub">{t('app.subtitle')}</div>
          </div>
        </div>
        {NAV.map((n, i) => (
          <button
            key={n.key}
            className={`nav-item${page === n.key ? ' active' : ''}`}
            onClick={() => setPage(n.key)}
            title={`Ctrl+${i + 1}`}
          >
            <span className="dot" />
            <span className="nav-text">
              <span className="nav-label">{t(n.labelKey)}</span>
              <span className="nav-desc">{t(n.descKey)}</span>
            </span>
          </button>
        ))}
        <div className="sidebar-foot">{t('nav.shortcut')}</div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="search-wrap">
            <input
              className="input search-input"
              placeholder={t('topbar.search')}
              value={search}
              onChange={(e) => void runSearch(e.target.value)}
              onFocus={() => q && setSearchOpen(true)}
              onBlur={() => {
                if (searchTimer.current) clearTimeout(searchTimer.current)
                searchTimer.current = setTimeout(() => setSearchOpen(false), 160)
              }}
            />
            {searchOpen && q && (
              <div className="search-drop">
                {!hasResults && <div className="search-empty">{t('topbar.noResult')}</div>}
                {resultProfiles.length > 0 && <div className="search-group">{t('topbar.groupProfiles')}</div>}
                {resultProfiles.map((p) => (
                  <div
                    className="search-item"
                    key={p.name}
                    onClick={() => {
                      setPage('profiles')
                      setSearchOpen(false)
                    }}
                  >
                    <span className={`dot ${p.running ? 'ok' : ''}`} />
                    <span className="search-name">{p.name}</span>
                    <span className="spacer" />
                    <button
                      className="btn sm"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        void quickStart(p.name)
                      }}
                    >
                      {t('topbar.start')}
                    </button>
                  </div>
                ))}
                {resultPlugins.length > 0 && <div className="search-group">{t('topbar.groupPlugins')}</div>}
                {resultPlugins.map((p) => (
                  <div
                    className="search-item"
                    key={p.name}
                    onClick={() => {
                      setPage('market')
                      setSearchOpen(false)
                    }}
                  >
                    <span className="search-name">{p.name}</span>
                    <span className="muted">{p.kind}</span>
                  </div>
                ))}
                {resultKernels.length > 0 && <div className="search-group">{t('topbar.groupKernels')}</div>}
                {resultKernels.map((k) => (
                  <div
                    className="search-item"
                    key={k.id}
                    onClick={() => {
                      setPage('kernels')
                      setSearchOpen(false)
                    }}
                  >
                    <span className="search-name">{k.name}</span>
                    <span className="muted">{k.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            className="topbar-version"
            title={`${shownVersionHint}\n点击前往「DSH 环境」页`}
            style={{ cursor: 'pointer' }}
            onClick={() => setPage('dsh-envs')}
          >
            {`DSH ${shownVersion || '—'} · ${dshStatus?.activeVersionName ? 'env' : 'PATH'}`}
          </div>
        </div>

        <Suspense fallback={<div className="empty">页面加载中…</div>}>
          {page === 'console' && <ControllerConsolePage onNavigate={setPage} />}
          {page === 'profiles' && <ProfilesPage />}
          {page === 'market' && <MarketPage />}
          {page === 'allocations' && <AllocationsPage />}
          {page === 'kernels' && <KernelsPage />}
          {page === 'dsh-envs' && <DshEnvsPage />}
          {page === 'settings' && (
            <SettingsPage locale={locale} changeLocale={changeLocale} theme={theme} changeTheme={changeTheme} onNavigate={setPage} />
          )}
        </Suspense>
      </main>
    </div>
  )
}
