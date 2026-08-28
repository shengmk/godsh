import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DshEnv, DshEnvsInfo, DshStatus, ProfileView } from '../types'
import { Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

const KIND_LABEL: Record<string, string> = { base: 'base 主环境', managed: '并列环境', external: '外部检测' }

export default function DshEnvsPage() {
  const [info, setInfo] = useState<DshEnvsInfo | null>(null)
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [publishedVersions, setPublishedVersions] = useState<string[]>([])
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [envName, setEnvName] = useState('')
  const [envVersion, setEnvVersion] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  async function load() {
    try {
      const [e, p, v, s] = await Promise.all([api.dshEnvs(), api.profiles(), api.dshVersions(), api.dshStatus()])
      setInfo(e)
      setProfiles(p)
      setPublishedVersions(v.published ?? [])
      setStatus(s)
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), true)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  // 后台安装任务轮询
  useEffect(() => {
    if (info?.tasks.some((x) => x.status === 'running')) {
      if (pollTimer.current) clearInterval(pollTimer.current)
      pollTimer.current = setInterval(() => void load(), 2000)
    } else if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [info])

  async function installBase() {
    try {
      await api.dshInstall()
      show('已开始安装官方 dsh（base 主环境），请稍候…')
      setTimeout(() => void load(), 1000)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function updateBase() {
    try {
      await api.dshUpdate()
      show('已开始更新 base 到最新版…')
      setTimeout(() => void load(), 1000)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function addEnv() {
    const name = envName.trim()
    if (!name) return show('请填写环境名', true)
    try {
      await api.dshEnvAdd(name, envVersion.trim() || undefined)
      show(`已开始安装并列环境 ${name}…`)
      setEnvName('')
      setEnvVersion('')
      setTimeout(() => void load(), 1000)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function removeEnv(env: DshEnv) {
    if (!window.confirm(`确定删除并列环境 ${env.id}（${env.dir}）？此操作不可撤销。`)) return
    try {
      await api.dshEnvRemove(env.id)
      show(`已删除环境 ${env.id}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function activate(env: DshEnv) {
    try {
      await api.dshEnvActivate(env.id)
      show(`已设为默认：${env.id}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function setProfileEnv(profile: string, value: string) {
    try {
      await api.updateSettings({ dsh: { byProfile: { [profile]: value } } })
      show(value ? `已为 ${profile} 指定环境 ${value}` : `已为 ${profile} 恢复默认`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function initHome() {
    try {
      const r = await api.dshInitHome()
      show(`已初始化：${r.home}（${r.created.join(', ') || '模板已存在'}）`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  if (!info) return <div className="empty">{t('dash.loading')}</div>

  const { envs, activeVersionName, byProfile, tasks } = info
  const activeId = activeVersionName.replace(/^env:/, '')
  const runningTask = tasks.find((x) => x.status === 'running')

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.dshEnvs.title')}</h1>
        <p className="page-desc">{t('page.dshEnvs.desc')}</p>
      </div>

      {runningTask && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(245, 158, 11, 0.5)' }}>
          <div className="card-title" style={{ color: 'var(--warn)' }}>
            安装中：{runningTask.key}
          </div>
          <div className="log-panel" style={{ marginTop: 8, maxHeight: 160 }}>
            {runningTask.log || '（等待输出…）'}
          </div>
        </div>
      )}

      {/* 未安装引导 */}
      {envs.length === 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">⚠ 未检测到 dsh</div>
          <p className="card-sub">一键安装官方 dsh 并建立 base 主环境（类比 Anaconda base），随后可添加并列环境。</p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => void installBase()}>
              自动安装官方 dsh（创建 base 主环境）
            </button>
            <button className="btn" onClick={() => void initHome()}>
              初始化官方默认模板
            </button>
          </div>
        </div>
      )}

      {/* 环境列表 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">
          DSH 环境（{envs.length}）
          <span className="badge kind">
            当前使用 v{status?.currentVersion ?? '?'}
          </span>
          {status && status.latestVersion && status.latestVersion !== status.currentVersion && (
            <span className="badge">{`有新版本：${status.latestVersion}`}</span>
          )}
        </div>
        <p className="card-sub">
          本机共检测到 {status?.detectedCount ?? envs.length} 个 dsh（不同安装/版本）。base 主环境由自动安装建立，并列环境可添加/删除。
        </p>
        {envs.length === 0 ? (
          <p className="muted">暂无环境，请先安装 base 主环境。</p>
        ) : (
          envs.map((e) => (
            <div className="row" key={e.id} style={{ marginTop: 10, alignItems: 'flex-start' }}>
              <span className={`badge ${activeId === e.id ? 'running' : 'stopped'}`}>
                {activeId === e.id ? '默认' : KIND_LABEL[e.kind] ?? e.kind}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong style={{ fontFamily: 'Consolas, monospace' }}>{e.id}</strong>
                  <span className="badge kind">v{e.version ?? '?'}</span>
                </div>
                <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {e.dir || e.run}
                </div>
              </div>
              <span className="spacer" />
              {activeId !== e.id && (
                <button className="btn sm" onClick={() => void activate(e)}>
                  {t('btn.setDefault')}
                </button>
              )}
              {e.kind === 'managed' && (
                <button className="btn danger sm" onClick={() => void removeEnv(e)}>
                  删除
                </button>
              )}
              {e.kind === 'base' && (
                <button className="btn sm" onClick={() => void updateBase()}>
                  更新到最新
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* 添加并列环境 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">添加并列环境（另一个 dsh 版本）</div>
        <p className="card-sub">安装到 Launcher 受管目录，可与 base 并列使用、可删除。</p>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" placeholder="环境名（如 v2）" value={envName} onChange={(e) => setEnvName(e.target.value)} />
          <select className="select" value={envVersion} onChange={(e) => setEnvVersion(e.target.value)}>
            <option value="">最新版（默认）</option>
            {publishedVersions.length === 0 ? (
              <option value="" disabled>
                暂无可用版本列表（离线？）
              </option>
            ) : (
              publishedVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))
            )}
          </select>
          <button className="btn primary" onClick={() => void addEnv()}>
            添加
          </button>
        </div>
        {tasks.length > 0 && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {tasks
              .filter((x) => x.status !== 'running')
              .map((x) => `${x.key}: ${x.status === 'done' ? '完成' : `失败${x.message ? `（${x.message}）` : ''}`}`)
              .join('；')}
          </div>
        )}
      </div>

      {/* 环境 ↔ Profile 分配 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">环境 ↔ Profile 分配</div>
        <p className="card-sub">每个环境（Profile）选择用哪个 DSH 环境启动；不指定则用默认。</p>
        {profiles.map((p) => (
          <div className="row" key={p.name} style={{ marginTop: 8 }}>
            <span className="muted" style={{ minWidth: 120 }}>
              {p.name}
            </span>
            <select
              className="select"
              value={byProfile[p.name] ?? ''}
              onChange={(e) => void setProfileEnv(p.name, e.target.value)}
            >
              <option value="">（默认）</option>
              {envs.map((e) => (
                <option key={e.id} value={`env:${e.id}`}>
                  {e.id}（v{e.version ?? '?'}）
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">DSH_HOME / 官方模板</div>
        <p className="card-sub">初始化 DSH_HOME 与官方默认 web 模板（base + web-app bundles）。</p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => void initHome()}>
            初始化官方默认模板
          </button>
        </div>
      </div>

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
