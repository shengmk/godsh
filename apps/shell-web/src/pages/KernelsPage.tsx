import { useEffect, useState } from 'react'
import { api } from '../api'
import type { KernelInstance, KernelTemplate, ProfileView, UnifiedKernelConfig } from '../types'
import { Toast } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'

export default function KernelsPage() {
  const [templates, setTemplates] = useState<KernelTemplate[]>([])
  const [instances, setInstances] = useState<KernelInstance[]>([])
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [unified, setUnified] = useState<UnifiedKernelConfig | null>(null)

  const [templateId, setTemplateId] = useState('')
  const [profile, setProfile] = useState('web')
  const [name, setName] = useState('')
  const [port, setPort] = useState('')
  const [ukId, setUkId] = useState('')
  const [ukName, setUkName] = useState('')
  const [kernelLogFor, setKernelLogFor] = useState<string | null>(null)
  const [kernelLog, setKernelLog] = useState('')
  const { toast, show } = useToast()
  const { t } = useI18n()

  // 内核实例日志轮询（每 2s）
  useEffect(() => {
    if (!kernelLogFor) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function poll() {
      try {
        const r = await api.kernelLog(kernelLogFor as string)
        if (!cancelled) setKernelLog(r.log)
      } catch {
        /* 忽略轮询错误 */
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [kernelLogFor])

  function toggleKernelLog(id: string) {
    setKernelLogFor((prev) => (prev === id ? null : id))
    setKernelLog('')
  }

  async function load() {
    try {
      const [k, p, u] = await Promise.all([api.kernels(), api.profiles(), api.unifiedKernel()])
      setTemplates(k.templates)
      setInstances(k.instances)
      setProfiles(p)
      setUnified(u)
      if (!templateId && k.templates.length) setTemplateId(k.templates[0]!.id)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function create() {
    if (!templateId) return show('请选择内核模板', true)
    try {
      const inst = await api.createKernel({
        templateId,
        profile: profile || undefined,
        port: port ? Number(port) : undefined,
        name: name || undefined,
      })
      setName('')
      setPort('')
      show(`已创建内核实例 ${inst.name}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function action(id: string, a: 'start' | 'stop') {
    try {
      const inst = await api.kernelAction(id, a)
      show(`内核 ${inst.name}: ${inst.status}${inst.error ? ` (${inst.error})` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function remove(id: string) {
    try {
      await api.removeKernel(id)
      show('已删除内核实例')
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function saveUnified(next: UnifiedKernelConfig) {
    try {
      const saved = await api.updateUnifiedKernel(next)
      setUnified(saved)
      show('已保存统一内核配置（下次启动生效）')
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 设置单个环境的注入覆盖（true=强制注入；false=跳过；null=跟随全局），保存后即时生效 */
  async function setProfileOverride(name: string, enabled: boolean | null) {
    try {
      const saved = await api.setUnifiedKernelProfile(name, enabled)
      setUnified(saved)
      show(enabled === null ? `已清除 ${name} 的覆盖（跟随全局）` : `已设置 ${name}：${enabled ? '强制注入' : '跳过注入'}`)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  function ukAdd() {
    if (!unified) return
    const id = ukId.trim()
    if (!id) return show('请填写插件 ID', true)
    if (unified.plugins.some((p) => p.id === id)) return show('该插件已在统一内核中', true)
    void saveUnified({ ...unified, plugins: [...unified.plugins, { id, name: ukName.trim() || id }] })
    setUkId('')
    setUkName('')
  }

  async function applyUnified() {
    try {
      const r = await api.unifiedKernelAction('apply')
      const added = r.results.filter((x) => x.added.length).length
      show(`已应用到全部环境${added ? `（${added} 个有变更）` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  async function revertUnified() {
    try {
      const r = await api.unifiedKernelAction('revert')
      const removed = r.results.filter((x) => x.added.length).length
      show(`已还原${removed ? `（${removed} 个环境移除了注入项）` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  function ukToggle(id: string, enabled: boolean) {
    if (!unified) return
    void saveUnified({
      ...unified,
      plugins: unified.plugins.map((p) => (p.id === id ? { ...p, disabled: !enabled } : p)),
    })
  }

  function ukRemove(id: string) {
    if (!unified) return
    void saveUnified({ ...unified, plugins: unified.plugins.filter((p) => p.id !== id) })
  }

  function ukMove(id: string, delta: number) {
    if (!unified) return
    const plugins = [...unified.plugins]
    const from = plugins.findIndex((p) => p.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= plugins.length) return
    const [item] = plugins.splice(from, 1)
    plugins.splice(to, 0, item!)
    void saveUnified({ ...unified, plugins })
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.kernels.title')}</h1>
        <p className="page-desc">{t('page.kernels.desc')}</p>
      </div>

      {unified && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">统一内核（注入所有 Profile 的 Web 内核）</div>
          <p className="card-sub">
            把 @deepseek-ai/dsh-web-app 及你偏好的插件并入每个 Profile 的 dsh.profile.bundles（dsh 原生机制，不装依赖、不改
            cordis.patch.yml）。没有 web-app 的 Profile（如 open-design、experiment）也能启动出 Web UI；禁用或还原时只移除本工具
            添加过的条目，不动你原有配置。
          </p>
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={unified.enabled}
                onChange={(e) => void saveUnified({ ...unified, enabled: e.target.checked })}
              />
              <span>启用统一内核</span>
            </label>
            <span className="spacer" />
            <button className="btn sm" onClick={() => void applyUnified()}>
              应用到所有环境
            </button>
            <button className="btn danger sm" onClick={() => void revertUnified()}>
              还原（移除本工具添加项）
            </button>
          </div>
          {unified.plugins.map((p, i) => (
            <div className="row" key={p.id} style={{ marginBottom: 8, gap: 8 }}>
              <span className={`badge ${p.disabled ? 'disabled' : 'enabled'}`}>{p.disabled ? '禁用' : '启用'}</span>
              <span style={{ fontFamily: 'Consolas, monospace' }}>{p.id}</span>
              {p.name && p.name !== p.id && <span className="muted">{p.name}</span>}
              <span className="spacer" />
              <button className="btn sm" onClick={() => ukMove(p.id, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="btn sm" onClick={() => ukMove(p.id, 1)} disabled={i >= unified.plugins.length - 1}>
                ↓
              </button>
              <button className="btn sm" onClick={() => ukToggle(p.id, !p.disabled)}>
                {p.disabled ? '启用' : '禁用'}
              </button>
              <button className="btn danger sm" onClick={() => ukRemove(p.id)}>
                移除
              </button>
            </div>
          ))}
          {unified.plugins.length === 0 && <p className="muted">统一内核暂无插件（默认应为 @deepseek-ai/dsh-web-app）</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <input className="input" placeholder="插件 ID（如 dshmarket）" value={ukId} onChange={(e) => setUkId(e.target.value)} />
            <input className="input" placeholder="插件名（可选）" value={ukName} onChange={(e) => setUkName(e.target.value)} />
            <button className="btn primary" onClick={ukAdd}>
              添加
            </button>
          </div>

          {/* 按环境覆盖：单个环境可强制注入 / 跳过注入 / 跟随全局 */}
          {profiles.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  按环境覆盖（可选）：强制注入 / 跳过注入 / 跟随全局
                </span>
              </div>
              {profiles.map((p) => {
                const override = unified.byProfile?.[p.name]
                const val = override === undefined ? '' : override ? 'force' : 'skip'
                return (
                  <div className="row" key={p.name} style={{ marginBottom: 6, gap: 8 }}>
                    <span className="muted" style={{ minWidth: 130 }}>
                      {p.name}
                    </span>
                    <select
                      className="select"
                      style={{ padding: '4px 8px', fontSize: 12 }}
                      value={val}
                      onChange={(e) => {
                        const v = e.target.value
                        void setProfileOverride(p.name, v === '' ? null : v === 'force')
                      }}
                    >
                      <option value="">跟随全局</option>
                      <option value="force">强制注入</option>
                      <option value="skip">跳过注入</option>
                    </select>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">新建内核实例</div>
        <div className="row">
          <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}（{t.name}）
              </option>
            ))}
          </select>
          <select className="select" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <input className="input" placeholder="端口（可选）" value={port} onChange={(e) => setPort(e.target.value)} />
          <input className="input" placeholder="实例名（可选）" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" onClick={create}>
            新建
          </button>
        </div>
      </div>

      <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>实例</h2>
      {instances.length === 0 ? (
        <div className="empty">暂无内核实例</div>
      ) : (
        <div className="grid">
          {instances.map((k) => (
            <div className="card" key={k.id}>
              <div className="card-title">
                {k.name}
                <span className={`badge ${k.status === 'running' ? 'running' : 'stopped'}`}>{k.status}</span>
              </div>
              <p className="card-sub">
                {k.templateId} · profile={k.profile ?? '-'} · port={k.port ?? '-'}
              </p>
              <div className="row">
                {k.status === 'running' ? (
                  <button className="btn danger sm" onClick={() => action(k.id, 'stop')}>
                    停止
                  </button>
                ) : (
                  <button className="btn primary sm" onClick={() => action(k.id, 'start')}>
                    启动
                  </button>
                )}
                <button className="btn sm" disabled={!k.profile || !k.port} onClick={() => toggleKernelLog(k.id)}>
                  {kernelLogFor === k.id ? '收起日志' : '日志'}
                </button>
                <button className="btn sm" disabled={k.status !== 'stopped'} onClick={() => remove(k.id)}>
                  删除
                </button>
              </div>
              {k.error && <p className="muted" style={{ marginTop: 8 }}>⚠ {k.error}</p>}
              {kernelLogFor === k.id && (
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="muted">每 3s 自动刷新</span>
                  <span className="spacer" />
                </div>
              )}
              {kernelLogFor === k.id && (
                <div className="log-panel" style={{ marginTop: 6, maxHeight: 180 }}>
                  {kernelLog || '（暂无日志）'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
