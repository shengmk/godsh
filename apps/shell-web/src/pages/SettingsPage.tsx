import { useEffect, useState } from 'react'
import {
  Box,
  Download,
  Upload,
  RotateCcw,
  Trash2,
  Save,
  RefreshCw,
  Info,
} from 'lucide-react'
import { api } from '../api'
import type { LauncherConfig, SettingsInfo } from '../types'
import { Loading, ToastStack } from '../components'
import { useAsyncAction, useToast } from '../hooks'
import { useI18n, type Locale } from '../i18n'
import { applyTheme, type Theme } from '../theme'
import { usePageRefresh } from '../refresh'
import { useConfirm } from '../use-confirm'

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
  const { toasts, show } = useToast()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [dshHome, setDshHome] = useState('')
  const [marketEnabled, setMarketEnabled] = useState(true)
  const [marketUrl, setMarketUrl] = useState('')
  const [extraDirs, setExtraDirs] = useState('')
  const [allowMultiPort, setAllowMultiPort] = useState(false)
  const [resetScope, setResetScope] = useState<'data' | 'all' | 'dsh-all'>('data')
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)

  async function load() {
    setReloading(true)
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
    } finally {
      setReloading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // bug 7：把本页既有的 load() 注册到全局刷新总线（顶栏全局刷新按钮 → triggerRefresh → load）
  usePageRefresh(load, 'settings')

  // U5：本页原先的 2 处 window.confirm 统一走自研确认框，dialog 在下方 JSX 渲染一次
  const { confirm, dialog } = useConfirm()

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

  /** 导出备份：失败时抛出真实原因，由 useAsyncAction 统一置忙 + 提示 */
  async function exportBackup() {
    const data = await api.backup()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `godsh-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const { run: runExportBackup, loading: exporting } = useAsyncAction(exportBackup, {
    show,
    success: '备份已导出',
    errorPrefix: '导出备份失败：',
  })

  /** 导入备份：返回已恢复项（未选文件返回 null），成功文案沿用既有格式 */
  async function importBackup(file: File | undefined): Promise<string[] | null> {
    if (!file) return null
    const data = JSON.parse(await file.text()) as Record<string, unknown>
    const r = await api.restoreBackup(data)
    await load()
    return r.restored
  }

  const { run: runImportBackup, loading: importing } = useAsyncAction(importBackup, {
    show,
    success: (restored) => (restored ? `备份已导入：${restored.join(', ')}` : ''),
    errorPrefix: '导入失败：',
  })

  /**
   * 重置确认（提示语保持原样），返回是否继续执行。
   *
   * U5：确认框从 window.confirm 换成自研 dialog 后必须等待用户选择，因此本函数改为 async；
   * 返回语义（true=继续，false=取消）完全不变，只是从同步布尔值变成了 Promise<boolean>。
   */
  async function confirmReset(): Promise<boolean> {
    const warn =
      resetScope === 'dsh-all'
        ? '「dsh 全删除」将卸载全局 dsh、删除整个 DSH_HOME（profiles/sessions/storages 等所有内容）与全部数据，且会停止所有环境。此操作不可恢复！请输入 DELETE 确认。'
        : resetScope === 'all'
          ? '将删除所有 Profile 目录并重置全部数据，不可恢复。确定继续？'
          : '将重置全部数据（config / kernels / allocations / unified-kernel / dsh-envs），保留 Profile 目录。确定继续？'
    if (resetScope === 'dsh-all') {
      // 这一支原本就是 window.prompt 的「输入 DELETE 才继续」，不属于 window.confirm，行为保持原样
      const typed = window.prompt(warn)
      if (typed !== 'DELETE') {
        show('已取消：未输入 DELETE 确认', true)
        return false
      }
      return true
    }
    return await confirm({ message: warn })
  }

  /** 执行重置：破坏性长操作，由 useAsyncAction 保证按钮置忙 + 真实错误提示 */
  async function resetAll() {
    const r = await api.resetAll(resetScope)
    await load()
    return r
  }

  const { run: runResetAll, loading: resetting } = useAsyncAction(resetAll, {
    show,
    success: (r) => `已重置（scope=${r.scope}）`,
    errorPrefix: '重置失败：',
  })

  /** 卸载 Launcher：确认框保留在点击处，异步部分交给 useAsyncAction 置忙 + 提示 */
  async function uninstall() {
    return api.appUninstall()
  }

  const { run: runUninstall, loading: uninstalling } = useAsyncAction(uninstall, {
    show,
    success: (r) => `已启动卸载程序：${r.path}`,
    errorPrefix: '卸载失败：',
  })

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
          <button className="btn" onClick={() => onNavigate('dsh-envs')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Box size={13} /> 前往 DSH 环境页
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
        <p className="muted" style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Info size={13} style={{ flexShrink: 0 }} />
          <span>默认关闭（推荐）：严格单环境单端口互斥。当启动新端口或重启环境时，自动终止并释放该环境的所有旧端口与旧进程，彻底避免端口污染与多进程写冲突。</span>
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
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button
            className="btn"
            disabled={exporting}
            onClick={() => void runExportBackup()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {exporting ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}{' '}
            {exporting ? '导出中…' : '导出备份'}
          </button>
          <label
            className="btn"
            aria-disabled={importing}
            style={{
              cursor: importing ? 'not-allowed' : 'pointer',
              opacity: importing ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {importing ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />}{' '}
            {importing ? '导入中…' : '导入备份'}
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              disabled={importing}
              onChange={(e) => void runImportBackup(e.target.files?.[0])}
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
          <button
            className="btn danger"
            disabled={resetting}
            onClick={() => {
              // confirmReset 现在需要等待对话框，用 async 包一层以保证「确认后才执行重置」的顺序不变
              void (async () => {
                if (!(await confirmReset())) return
                void runResetAll()
              })()
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {resetting ? <RefreshCw size={13} className="animate-spin" /> : <RotateCcw size={13} />}{' '}
            {resetting ? '执行中…' : '执行重置'}
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
          <button
            className="btn danger"
            disabled={uninstalling}
            onClick={() => {
              void (async () => {
                if (!(await confirm({ message: '将调用 uninstall.exe 卸载本应用，确定继续？' }))) return
                void runUninstall()
              })()
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {uninstalling ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}{' '}
            {uninstalling ? '卸载中…' : '卸载 Launcher（调用 uninstall.exe）'}
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={saving} onClick={() => void save()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Save size={13} /> {saving ? '…' : t('btn.save')}
        </button>
        <button
          className="btn"
          disabled={reloading}
          onClick={() => void load()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={13} className={reloading ? 'animate-spin' : ''} /> {reloading ? '刷新中…' : t('btn.refresh')}
        </button>
      </div>

      <ToastStack toasts={toasts} />
      {dialog}
    </>
  )
}
