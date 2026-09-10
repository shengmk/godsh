import { useEffect, useState } from 'react'
import {
  Play,
  Square,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  FileText,
  AlertTriangle,
  Check,
  RotateCcw,
  Binary,
  RefreshCw,
} from 'lucide-react'
import { api } from '../api'
import type { KernelInstance, KernelTemplate, ProfileView, UnifiedKernelConfig } from '../types'
import { EmptyState, Toast } from '../components'
import { useAsyncAction, useToast } from '../hooks'
import { usePageRefresh } from '../refresh'
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
  /** 页面数据重新加载中（页面刷新按钮 + 顶栏全局刷新共用 load()） */
  const [reloading, setReloading] = useState(false)
  /** 实例级动作占用：启动/停止/删除（同一时刻只允许一个，避免竞态） */
  const [kernelBusy, setKernelBusy] = useState<{ id: string; kind: 'start' | 'stop' | 'remove' } | null>(null)
  /** 统一内核保存中：插件 id / 'add' / 'enabled'，用于精确禁用与展示进度 */
  const [savingUnified, setSavingUnified] = useState<string | null>(null)
  /** 按环境覆盖保存中（保存的是环境名） */
  const [overrideBusy, setOverrideBusy] = useState<string | null>(null)
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
    setReloading(true)
    try {
      const [k, p, u] = await Promise.all([api.kernels(), api.profiles(), api.unifiedKernel()])
      setTemplates(k.templates)
      setInstances(k.instances)
      setProfiles(p)
      setUnified(u)
      if (!templateId && k.templates.length) setTemplateId(k.templates[0]!.id)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setReloading(false)
    }
  }

  // 注册到全局刷新总线（bug 7）：顶栏刷新按钮与页面刷新按钮复用同一份 load()，不新增请求逻辑
  usePageRefresh(load, 'kernels')

  useEffect(() => {
    void load()
  }, [])

  /** 新建实例：loading 由 useAsyncAction 统一管理，成功文案沿用原提示 */
  const { run: runCreateKernel, loading: creating } = useAsyncAction(
    async () => {
      const inst = await api.createKernel({
        templateId,
        profile: profile || undefined,
        port: port ? Number(port) : undefined,
        name: name || undefined,
      })
      setName('')
      setPort('')
      await load()
      return inst
    },
    { show, success: (inst) => `已创建内核实例 ${inst.name}` },
  )

  function create() {
    if (!templateId) return show('请选择内核模板', true)
    void runCreateKernel()
  }

  async function action(id: string, a: 'start' | 'stop') {
    setKernelBusy({ id, kind: a })
    try {
      const inst = await api.kernelAction(id, a)
      show(`内核 ${inst.name}: ${inst.status}${inst.error ? ` (${inst.error})` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setKernelBusy(null)
    }
  }

  async function remove(id: string) {
    setKernelBusy({ id, kind: 'remove' })
    try {
      await api.removeKernel(id)
      show('已删除内核实例')
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setKernelBusy(null)
    }
  }

  /** 统一内核写操作：key 用于精确定位当前正在保存的控件（插件 id / 'add' / 'enabled'） */
  async function saveUnified(next: UnifiedKernelConfig, key: string) {
    setSavingUnified(key)
    try {
      const saved = await api.updateUnifiedKernel(next)
      setUnified(saved)
      show('已保存统一内核配置（下次启动生效）')
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setSavingUnified(null)
    }
  }

  /** 设置单个环境的注入覆盖（true=强制注入；false=跳过；null=跟随全局），保存后即时生效 */
  async function setProfileOverride(name: string, enabled: boolean | null) {
    setOverrideBusy(name)
    try {
      const saved = await api.setUnifiedKernelProfile(name, enabled)
      setUnified(saved)
      show(enabled === null ? `已清除 ${name} 的覆盖（跟随全局）` : `已设置 ${name}：${enabled ? '强制注入' : '跳过注入'}`)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setOverrideBusy(null)
    }
  }

  /** 应用到所有环境：loading 由 useAsyncAction 管理，成功文案沿用原提示 */
  const { run: runApplyUnified, loading: applyingUnified } = useAsyncAction(
    async () => {
      const r = await api.unifiedKernelAction('apply')
      await load()
      return r
    },
    {
      show,
      success: (r) => {
        const added = r.results.filter((x) => x.added.length).length
        return `已应用到全部环境${added ? `（${added} 个有变更）` : ''}`
      },
    },
  )

  /** 还原（移除本工具添加项）：loading 由 useAsyncAction 管理，成功文案沿用原提示 */
  const { run: runRevertUnified, loading: revertingUnified } = useAsyncAction(
    async () => {
      const r = await api.unifiedKernelAction('revert')
      await load()
      return r
    },
    {
      show,
      success: (r) => {
        const removed = r.results.filter((x) => x.added.length).length
        return `已还原${removed ? `（${removed} 个环境移除了注入项）` : ''}`
      },
    },
  )

  function ukAdd() {
    if (!unified) return
    const id = ukId.trim()
    if (!id) return show('请填写插件 ID', true)
    if (unified.plugins.some((p) => p.id === id)) return show('该插件已在统一内核中', true)
    void saveUnified({ ...unified, plugins: [...unified.plugins, { id, name: ukName.trim() || id }] }, 'add')
    setUkId('')
    setUkName('')
  }

  function ukToggle(id: string, enabled: boolean) {
    if (!unified) return
    void saveUnified(
      {
        ...unified,
        plugins: unified.plugins.map((p) => (p.id === id ? { ...p, disabled: !enabled } : p)),
      },
      id,
    )
  }

  function ukRemove(id: string) {
    if (!unified) return
    void saveUnified({ ...unified, plugins: unified.plugins.filter((p) => p.id !== id) }, id)
  }

  function ukMove(id: string, delta: number) {
    if (!unified) return
    const plugins = [...unified.plugins]
    const from = plugins.findIndex((p) => p.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= plugins.length) return
    const [item] = plugins.splice(from, 1)
    plugins.splice(to, 0, item!)
    void saveUnified({ ...unified, plugins }, id)
  }

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">{t('page.kernels.title')}</h1>
          <p className="page-desc">{t('page.kernels.desc')}</p>
        </div>
        <button
          className="btn sm"
          disabled={reloading}
          onClick={() => void load()}
          title="重新加载内核模板、实例与统一内核配置"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={13} className={reloading ? 'animate-spin' : ''} />
          {reloading ? '刷新中…' : '刷新'}
        </button>
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
                disabled={savingUnified === 'enabled'}
                onChange={(e) => void saveUnified({ ...unified, enabled: e.target.checked }, 'enabled')}
              />
              <span>启用统一内核</span>
              {savingUnified === 'enabled' && (
                <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <RefreshCw size={12} className="animate-spin" /> 保存中…
                </span>
              )}
            </label>
            <span className="spacer" />
            <button
              className="btn sm"
              disabled={applyingUnified}
              onClick={() => void runApplyUnified()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              {applyingUnified ? (
                <><RefreshCw size={12} className="animate-spin" /> 应用中…</>
              ) : (
                <><Check size={12} /> 应用到所有环境</>
              )}
            </button>
            <button
              className="btn danger sm"
              disabled={revertingUnified}
              onClick={() => void runRevertUnified()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              {revertingUnified ? (
                <><RefreshCw size={12} className="animate-spin" /> 还原中…</>
              ) : (
                <><RotateCcw size={12} /> 还原（移除本工具添加项）</>
              )}
            </button>
          </div>
          {unified.plugins.map((p, i) => {
            const rowSaving = savingUnified === p.id
            const rowLocked = savingUnified !== null
            return (
              <div className="row" key={p.id} style={{ marginBottom: 8, gap: 8 }}>
                <span className={`badge ${p.disabled ? 'disabled' : 'enabled'}`}>{p.disabled ? '禁用' : '启用'}</span>
                <span style={{ fontFamily: 'Consolas, monospace' }}>{p.id}</span>
                {p.name && p.name !== p.id && <span className="muted">{p.name}</span>}
                {rowSaving && (
                  <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <RefreshCw size={12} className="animate-spin" /> 处理中…
                  </span>
                )}
                <span className="spacer" />
                <button className="btn sm" onClick={() => ukMove(p.id, -1)} disabled={i === 0 || rowLocked} title="上移">
                  <ArrowUp size={12} />
                </button>
                <button
                  className="btn sm"
                  onClick={() => ukMove(p.id, 1)}
                  disabled={i >= unified.plugins.length - 1 || rowLocked}
                  title="下移"
                >
                  <ArrowDown size={12} />
                </button>
                <button className="btn sm" disabled={rowLocked} onClick={() => ukToggle(p.id, !p.disabled)}>
                  {p.disabled ? '启用' : '禁用'}
                </button>
                <button
                  className="btn danger sm"
                  disabled={rowLocked}
                  onClick={() => ukRemove(p.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Trash2 size={11} /> 移除
                </button>
              </div>
            )
          })}
          {unified.plugins.length === 0 && <p className="muted">统一内核暂无插件（默认应为 @deepseek-ai/dsh-web-app）</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="input"
              placeholder="插件 ID（如 dshmarket）"
              value={ukId}
              disabled={savingUnified !== null}
              onChange={(e) => setUkId(e.target.value)}
            />
            <input
              className="input"
              placeholder="插件名（可选）"
              value={ukName}
              disabled={savingUnified !== null}
              onChange={(e) => setUkName(e.target.value)}
            />
            <button
              className="btn primary"
              disabled={savingUnified !== null}
              onClick={ukAdd}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              {savingUnified === 'add' ? (
                <><RefreshCw size={13} className="animate-spin" /> 添加中…</>
              ) : (
                <><Plus size={13} /> 添加</>
              )}
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
                      disabled={overrideBusy !== null}
                      onChange={(e) => {
                        const v = e.target.value
                        void setProfileOverride(p.name, v === '' ? null : v === 'force')
                      }}
                    >
                      <option value="">跟随全局</option>
                      <option value="force">强制注入</option>
                      <option value="skip">跳过注入</option>
                    </select>
                    {overrideBusy === p.name && (
                      <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <RefreshCw size={12} className="animate-spin" /> 保存中…
                      </span>
                    )}
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
          <button
            className="btn primary"
            disabled={creating}
            onClick={create}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            {creating ? (
              <><RefreshCw size={13} className="animate-spin" /> 创建中…</>
            ) : (
              <><Plus size={13} /> 新建</>
            )}
          </button>
        </div>
      </div>

      <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>实例</h2>
      {instances.length === 0 ? (
        <EmptyState
          compact
          icon={Binary}
          title="暂无运行中的内核实例"
          description="当前尚未独立启动 Kernel 实例。您可以选择指定模版与目标 Profile 创建新内核实例并启动。"
        />
      ) : (
        <div className="grid">
          {instances.map((k) => {
            const busyKind = kernelBusy && kernelBusy.id === k.id ? kernelBusy.kind : null
            const busy = kernelBusy !== null
            return (
              <div className="card" key={k.id}>
                <div className="card-title">
                  {k.name}
                  <span className={`badge ${k.status === 'running' ? 'running' : 'stopped'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {k.status === 'running' && <span className="pulse-dot active" style={{ width: 6, height: 6, display: 'inline-block' }} />}
                    {k.status}
                  </span>
                </div>
                <p className="card-sub">
                  {k.templateId} · profile={k.profile ?? '-'} · port={k.port ?? '-'}
                </p>
                <div className="row">
                  {k.status === 'running' ? (
                    <button
                      className="btn danger sm"
                      disabled={busy}
                      onClick={() => void action(k.id, 'stop')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      {busyKind === 'stop' ? (
                        <><RefreshCw size={11} className="animate-spin" /> 停止中…</>
                      ) : (
                        <><Square size={11} /> 停止</>
                      )}
                    </button>
                  ) : (
                    <button
                      className="btn primary sm"
                      disabled={busy}
                      onClick={() => void action(k.id, 'start')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      {busyKind === 'start' ? (
                        <><RefreshCw size={11} className="animate-spin" /> 启动中…</>
                      ) : (
                        <><Play size={11} /> 启动</>
                      )}
                    </button>
                  )}
                  <button className="btn sm" disabled={!k.profile || !k.port} onClick={() => toggleKernelLog(k.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FileText size={11} /> {kernelLogFor === k.id ? '收起日志' : '日志'}
                  </button>
                  <button
                    className="btn sm"
                    disabled={k.status !== 'stopped' || busy}
                    onClick={() => void remove(k.id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    {busyKind === 'remove' ? (
                      <><RefreshCw size={11} className="animate-spin" /> 删除中…</>
                    ) : (
                      <><Trash2 size={11} /> 删除</>
                    )}
                  </button>
                </div>
                {k.error && (
                  <p className="muted" style={{ marginTop: 8, color: 'var(--err)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <AlertTriangle size={13} /> {k.error}
                  </p>
                )}
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
            )
          })}
        </div>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
    </>
  )
}
