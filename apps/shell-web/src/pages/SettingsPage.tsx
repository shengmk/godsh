import { useEffect, useState } from 'react'
import { api } from '../api'
import type { LauncherConfig, SettingsInfo } from '../types'
import { Loading, Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n, type Locale } from '../i18n'
import { applyTheme, type Theme } from '../theme'

type PageKey = 'console' | 'profiles' | 'market' | 'allocations' | 'kernels' | 'dsh-envs' | 'settings'

interface Props {
  locale: Locale
  changeLocale: (l: Locale) => void
  theme: Theme
  changeTheme: (t: Theme) => void
  onNavigate: (p: PageKey) => void
}

export default function SettingsPage({ locale, changeLocale, theme, changeTheme, onNavigate }: Props) {
  const { t } = useI18n()
  const { toast, show } = useToast()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [dshHome, setDshHome] = useState('')
  const [marketEnabled, setMarketEnabled] = useState(true)
  const [marketUrl, setMarketUrl] = useState('')
  const [extraDirs, setExtraDirs] = useState('')
  const [allowMultiPort, setAllowMultiPort] = useState(false)
  const [resetScope, setResetScope] = useState<'data' | 'all' | 'dsh-all'>('data')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const s = await api.settings()
      setInfo(s)
      setDshHome(s.config.dsh.home ?? '')
      setMarketEnabled(s.config.pluginMarket.enabled)
      setMarketUrl(s.config.pluginMarket.indexUrl)
      setExtraDirs((s.config.dsh.dirs ?? []).join('\n'))
      setAllowMultiPort(s.config.webKernel?.allowMultiPort ?? false)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function save() {
    setSaving(true)
    try {
      const dirs = extraDirs
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      await api.updateSettings({
        dsh: { home: dshHome.trim(), dirs },
        pluginMarket: { enabled: marketEnabled, indexUrl: marketUrl.trim() },
        webKernel: { ...(info?.config.webKernel ?? { defaultTemplateId: 'web-default', defaultPort: 3080 }), allowMultiPort },
      } as Partial<LauncherConfig>)
      show(t('settings.saved'))
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setSaving(false)
    }
  }

  async function exportBackup() {
    try {
      const data = await api.backup()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `godsh-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      show('备份已导出')
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function importBackup(file: File | undefined) {
    if (!file) return
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>
      const r = await api.restoreBackup(data)
      show(`备份已导入：${r.restored.join(', ')}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function doReset() {
    const warn =
      resetScope === 'dsh-all'
        ? '「dsh 全删除」将卸载全局 dsh、删除整个 DSH_HOME（profiles/sessions/storages 等所有内容）与全部数据，且会停止所有环境。此操作不可恢复！请输入 DELETE 确认。'
        : resetScope === 'all'
          ? '将删除所有 Profile 目录并重置全部数据，不可恢复。确定继续？'
          : '将重置全部数据（config / kernels / allocations / unified-kernel / dsh-envs），保留 Profile 目录。确定继续？'
    if (resetScope === 'dsh-all') {
      const typed = window.prompt(warn)
      if (typed !== 'DELETE') return show('已取消：未输入 DELETE 确认', true)
    } else if (!window.confirm(warn)) {
      return
    }
    try {
      const r = await api.resetAll(resetScope)
      show(`已重置（scope=${r.scope}）`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function doUninstall() {
    if (!window.confirm('将调用 uninstall.exe 卸载本应用，确定继续？')) return
    try {
      const r = await api.appUninstall()
      show(`已启动卸载程序：${r.path}`)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  if (!info) return <Loading />

  const { config, paths } = info

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.settings.title')}</h1>
        <p className="page-desc">{t('page.settings.desc')}</p>
      </div>

      {/* 外观 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('settings.appearance')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted">{t('settings.theme')}</span>
          <select
            className="select"
            value={theme}
            onChange={(e) => {
              const v = e.target.value as Theme
              changeTheme(v)
              applyTheme(v)
            }}
          >
            <option value="light">{t('settings.theme.light')}</option>
            <option value="dark">{t('settings.theme.dark')}</option>
            <option value="system">{t('settings.theme.system')}</option>
          </select>
          <span className="muted">{t('settings.language')}</span>
          <select className="select" value={locale} onChange={(e) => changeLocale(e.target.value as Locale)}>
            <option value="zh-CN">{t('settings.lang.zh')}</option>
            <option value="en">{t('settings.lang.en')}</option>
          </select>
        </div>
      </div>

      {/* DSH 环境（引导到独立页） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">DSH 环境 / 运行时</div>
        <p className="card-sub">dsh 版本检测、base 主环境与并列环境管理、自动安装、每环境版本分配已移至「DSH 环境」页。</p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => onNavigate('dsh-envs')}>
            前往 DSH 环境页
          </button>
        </div>
      </div>

      {/* 文件位置 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('settings.paths')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted" style={{ minWidth: 130 }}>
            {t('settings.dshHome')}
          </span>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="C:\Users\you\.dsh"
            value={dshHome}
            onChange={(e) => setDshHome(e.target.value)}
          />
        </div>
        {[
          { label: t('settings.dataDir'), value: paths.dataDir },
          { label: t('settings.logDir'), value: paths.logDir },
          { label: t('settings.templatesDir'), value: paths.templatesDir },
          { label: t('settings.pluginsDir'), value: paths.pluginsDir },
        ].map((p) => (
          <div className="row" key={p.label} style={{ marginTop: 8 }}>
            <span className="muted" style={{ minWidth: 130 }}>
              {p.label}
            </span>
            <code className="path-code">{p.value}</code>
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted" style={{ minWidth: 130 }}>
            {t('settings.extraDirs')}
          </span>
          <textarea
            className="input"
            rows={2}
            style={{ flex: 1, fontFamily: 'Consolas, monospace', fontSize: 12, resize: 'vertical' }}
            placeholder="每行一个 dsh 包目录"
            value={extraDirs}
            onChange={(e) => setExtraDirs(e.target.value)}
          />
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          {t('common.restartNote')}
        </p>
      </div>

      {/* 端口与运行模式 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">端口与运行模式</div>
        <p className="card-sub">
          管理各环境运行时的端口分配策略与多实例行为。
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allowMultiPort}
              onChange={(e) => setAllowMultiPort(e.target.checked)}
            />
            <span>允许自定义多端口并发（同一环境在不同端口同时运行）</span>
          </label>
        </div>
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          💡 默认关闭（推荐）：严格单环境单端口互斥。当启动新端口或重启环境时，自动终止并释放该环境的所有旧端口与旧进程，彻底避免端口污染与多进程写冲突。
        </p>
      </div>

      {/* 市场 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('settings.market')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={marketEnabled} onChange={(e) => setMarketEnabled(e.target.checked)} />
            <span>{t('settings.marketEnabled')}</span>
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted" style={{ minWidth: 130 }}>
            {t('settings.marketUrl')}
          </span>
          <input className="input" style={{ flex: 1 }} value={marketUrl} onChange={(e) => setMarketUrl(e.target.value)} />
        </div>
      </div>

      {/* 数据备份 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">数据备份</div>
        <p className="card-sub">导出 / 导入 Launcher 数据（config / kernels / allocations / unified-kernel）</p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => void exportBackup()}>
            导出备份
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            导入备份
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => void importBackup(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>

      {/* 高级：重置 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title" style={{ color: 'var(--warn)' }}>
          dsh 全部清空（重置）
        </div>
        <p className="card-sub">范围由你选择；重置前会停止所有运行中的环境。</p>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="reset-scope"
              checked={resetScope === 'data'}
              onChange={() => setResetScope('data')}
            />
            <span>仅重置数据（保留 Profile 目录）</span>
          </label>
          <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="radio" name="reset-scope" checked={resetScope === 'all'} onChange={() => setResetScope('all')} />
            <span style={{ color: 'var(--err)' }}>数据 + 删除所有 Profile 目录（极破坏性）</span>
          </label>
          <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="reset-scope"
              checked={resetScope === 'dsh-all'}
              onChange={() => setResetScope('dsh-all')}
            />
            <span style={{ color: 'var(--err)', fontWeight: 700 }}>dsh 全删除（卸载 dsh + 删除整个 DSH_HOME + 全部数据）</span>
          </label>
          <button className="btn danger" onClick={() => void doReset()}>
            执行重置
          </button>
        </div>
      </div>

      {/* 关于 / 卸载 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">关于</div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">
            godsh v{config.launcher.version} · DSH 环境管理请前往「DSH 环境」页
          </span>
          <span className="spacer" />
          <button className="btn danger" onClick={() => void doUninstall()}>
            卸载 Launcher（调用 uninstall.exe）
          </button>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? '…' : t('btn.save')}
        </button>
        <button className="btn" onClick={() => void load()}>
          {t('btn.refresh')}
        </button>
      </div>

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
