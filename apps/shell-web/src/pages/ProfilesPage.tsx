import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DshInstance, Health, PortInfo, ProfileView } from '../types'
import { ConfirmDialog, ContextMenu, ErrorText, Loading, Toast, type MenuState } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'
import { isTauri, openDshUrl, openExternal } from '../tauri'

export default function ProfilesPage() {
  const [health, setHealth] = useState<Health | null>(null)
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null)
  const [dshInstances, setDshInstances] = useState<DshInstance[]>([])
  const [byProfileVersion, setByProfileVersion] = useState<Record<string, string>>({})
  const [logFor, setLogFor] = useState<string | null>(null)
  const [log, setLog] = useState<string>('')
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 删除确认：null=不显示；{ name }=单个；{ names: string[] }=批量
  const [deleteTarget, setDeleteTarget] = useState<{ name?: string; names?: string[] } | null>(null)
  const [deleting, setDeleting] = useState(false)
  // 端口占用面板
  const [showPorts, setShowPorts] = useState(false)
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  // 每环境自定义启动端口（留空 = 自动找空闲端口）
  const [customPort, setCustomPort] = useState<Record<string, string>>({})
  const logRef = useRef<HTMLDivElement | null>(null)
  const { toast, show } = useToast()
  const { t } = useI18n()

  const load = useCallback(async () => {
    try {
      const [h, p] = await Promise.all([api.health(), api.profiles()])
      setHealth(h)
      setProfiles(p)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }, [show])

  useEffect(() => {
    void load()
    api
      .settings()
      .then((s) => {
        setDshInstances(s.dshInstances)
        setByProfileVersion(s.config.dsh.byProfile ?? {})
      })
      .catch(() => {})
  }, [load])

  // 指定 Profile 使用的 dsh 版本
  async function setProfileVersion(name: string, instance: string) {
    try {
      await api.updateSettings({ dsh: { byProfile: { [name]: instance } } })
      setByProfileVersion((prev) => ({ ...prev, [name]: instance }))
      show(instance ? `已为 ${name} 指定版本 ${instance}` : `已为 ${name} 恢复默认版本`)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  // 每 3s 自动刷新运行状态：合并轮询（一次请求返回所有环境状态，替代逐环境请求）
  useEffect(() => {
    const t = setInterval(async () => {
      if (!profiles || profiles.length === 0) return
      try {
        const names = profiles.map((p) => p.name)
        const statuses = await api.profilesStatus(names)
        setProfiles((prev) =>
          prev
            ? prev.map((p) => {
                const s = statuses[p.name]
                if (!s) return p
                return {
                  ...p,
                  running: s.running,
                  starting: s.starting,
                  port: s.port,
                  pid: s.pid,
                  url: s.url,
                  procError: s.procError ?? null,
                }
              })
            : prev,
        )
      } catch {
        /* 轮询失败时静默，下一次再试 */
      }
    }, 3000)
    return () => clearInterval(t)
  }, [profiles])

  // 打开日志后每 2s 轮询，实时滚动到底部
  useEffect(() => {
    if (!logFor || paused) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      try {
        const r = await api.profileLog(logFor as string)
        if (!cancelled) setLog(r.log)
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
  }, [logFor, paused])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  async function start(name: string) {
    setBusy(name)
    const portText = (customPort[name] ?? '').trim()
    const port = portText ? Number.parseInt(portText, 10) : undefined
    if (portText && (Number.isNaN(port) || port! <= 0 || port! > 65535)) {
      show('端口需为 1-65535 的数字', true)
      setBusy(null)
      return
    }
    try {
      await api.startProfile(name, port)
      show(port ? `正在启动 ${name}（端口 ${port}）…` : `正在启动 ${name}（自动端口）…`)
      setTimeout(load, 1500)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setBusy(null)
    }
  }

  async function stop(name: string) {
    setBusy(name)
    try {
      const r = await api.stopProfile(name)
      show(r.message ?? `已停止 ${name}`)
      load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setBusy(null)
    }
  }

  /** 打开环境：优先 DSH Desktop 软件，无则浏览器打开；按实际方式提示。 */
  async function openDsh(p: { name?: string; profile?: string; url: string | null }) {
    const label = p.name ?? p.profile ?? 'dsh'
    if (!p.url) return show('环境未运行或地址不可用', true)
    try {
      const mode = await openDshUrl(label, p.url)
      show(mode === 'desktop' ? `已用 DSH Desktop 打开 ${label}` : `已在浏览器打开 ${label}`)
    } catch (e) {
      show(`打开失败：${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  function viewLog(name: string) {
    if (logFor === name) {
      setLogFor(null)
      setLog('')
      setPaused(false)
      return
    }
    setLogFor(name)
    setLog('')
    setPaused(false)
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      show(`已复制 ${label}`)
    } catch {
      show('复制失败', true)
    }
  }

  function onContext(p: ProfileView, e: React.MouseEvent) {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        p.running
          ? { label: '停止', onClick: () => void stop(p.name) }
          : { label: '启动', onClick: () => void start(p.name), disabled: p.starting || !p.exists },
        p.running && p.url
          ? { label: isTauri() ? '用 DSH Desktop 打开' : '打开 Web UI', onClick: () => void openDsh(p) }
          : { label: '打开 Web UI', disabled: true, onClick: () => {} },
        p.running && p.url
          ? { label: '在系统浏览器打开', onClick: () => void openExternal(p.url!) }
          : { label: '在系统浏览器打开', disabled: true, onClick: () => {} },
        { label: '查看日志', onClick: () => viewLog(p.name) },
        { separator: true, label: '', onClick: () => {} },
        p.port ? { label: `复制端口 ${p.port}`, onClick: () => void copy(String(p.port), '端口') } : { label: '复制端口', disabled: true, onClick: () => {} },
        p.url ? { label: '复制地址', onClick: () => void copy(p.url!, '地址') } : { label: '复制地址', disabled: true, onClick: () => {} },
        { separator: true, label: '', onClick: () => {} },
        { label: '删除环境', onClick: () => setDeleteTarget({ name: p.name }), danger: true, disabled: p.running },
      ],
    })
  }

  async function createNewProfile() {
    const name = newName.trim()
    if (!name) return show('请输入环境名', true)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return show('环境名只能含字母/数字/-/_（≤64）', true)
    setCreating(true)
    try {
      const r = await api.createProfile(name)
      show(`已创建环境 ${r.profile}（官方默认模板）`)
      setNewName('')
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setCreating(false)
    }
  }

  /** 确认删除单个环境（需输入环境名） */
  async function confirmDeleteOne(name: string) {
    setDeleting(true)
    try {
      await api.deleteProfile(name)
      show(`已删除环境 ${name}`)
      setDeleteTarget(null)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setDeleting(false)
    }
  }

  /** 确认批量删除（需输入 DELETE） */
  async function confirmDeleteBatch(names: string[]) {
    setDeleting(true)
    let ok = 0
    const failed: string[] = []
    for (const n of names) {
      try {
        await api.deleteProfile(n)
        ok++
      } catch (e) {
        failed.push(`${n}（${e instanceof Error ? e.message : String(e)}）`)
      }
    }
    setDeleteTarget(null)
    setSelected(new Set())
    show(
      failed.length > 0 ? `已删除 ${ok} 个环境；失败：${failed.join('、')}` : `已删除 ${ok} 个环境`,
      failed.length > 0,
    )
    await load()
    setDeleting(false)
  }

  /** 批量启动所选环境（跳过已在运行/启动中的，串行执行并汇总结果） */
  async function batchStart(names: string[]) {
    setBusy('__batch__')
    let ok = 0
    let skipped = 0
    const failed: string[] = []
    for (const n of names) {
      const p = profiles?.find((x) => x.name === n)
      if (p?.running || p?.starting) {
        skipped++
        continue
      }
      try {
        await api.startProfile(n)
        ok++
      } catch (e) {
        failed.push(`${n}（${e instanceof Error ? e.message : String(e)}）`)
      }
    }
    setBusy(null)
    show(
      failed.length > 0
        ? `已启动 ${ok} 个${skipped ? `，跳过 ${skipped} 个运行中` : ''}；失败：${failed.join('、')}`
        : `已启动 ${ok} 个${skipped ? `，跳过 ${skipped} 个运行中` : ''}`,
      failed.length > 0,
    )
    setTimeout(load, 1500)
  }

  /** 批量停止所选环境（跳过未运行的，串行执行并汇总结果） */
  async function batchStop(names: string[]) {
    setBusy('__batch__')
    let ok = 0
    let skipped = 0
    const failed: string[] = []
    for (const n of names) {
      const p = profiles?.find((x) => x.name === n)
      if (!p?.running && !p?.starting) {
        skipped++
        continue
      }
      try {
        await api.stopProfile(n)
        ok++
      } catch (e) {
        failed.push(`${n}（${e instanceof Error ? e.message : String(e)}）`)
      }
    }
    setBusy(null)
    show(
      failed.length > 0
        ? `已停止 ${ok} 个${skipped ? `，跳过 ${skipped} 个未运行` : ''}；失败：${failed.join('、')}`
        : `已停止 ${ok} 个${skipped ? `，跳过 ${skipped} 个未运行` : ''}`,
      failed.length > 0,
    )
    load()
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** 打开/刷新端口占用面板 */
  async function togglePorts() {
    if (showPorts) {
      setShowPorts(false)
      return
    }
    setShowPorts(true)
    setPorts(null)
    try {
      const r = await api.ports()
      setPorts(r)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  const selectedNames = Array.from(selected)
  const runningSelected = (profiles ?? []).filter((p) => selected.has(p.name) && p.running)

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t('page.profiles.title')}</h1>
        <p className="page-desc">
          {health
            ? `DSH ${health.dsh.version ?? ''} · node ${health.node.version ?? ''} · pnpm ${health.pnpm.version ?? ''} · ${health.profilesDir}`
            : '加载环境信息…'}
        </p>
      </div>

      <div className="toolbar">
        <input
          className="input"
          placeholder="新环境名（如 myenv）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createNewProfile()
          }}
        />
        <button className="btn primary" disabled={creating} onClick={() => void createNewProfile()}>
          {creating ? '创建中…' : '新建环境'}
        </button>
        <span className="muted">默认模板：@deepseek-ai/dsh-base + dsh-web-app</span>
        <span className="spacer" />
        {selectedNames.length > 0 && (
          <>
            <span className="muted">已选 {selectedNames.length} 个</span>
            <button className="btn sm" onClick={() => setSelected(new Set())}>
              清空
            </button>
            <button
              className="btn sm"
              disabled={busy === '__batch__'}
              title="批量启动所选环境"
              onClick={() => void batchStart(selectedNames)}
            >
              ▶ 批量启动
            </button>
            <button
              className="btn sm"
              disabled={busy === '__batch__'}
              title="批量停止所选环境"
              onClick={() => void batchStop(selectedNames)}
            >
              ⏹ 批量停止
            </button>
            <button
              className="btn danger sm"
              disabled={runningSelected.length > 0}
              title={runningSelected.length > 0 ? `请先停止运行中的环境：${runningSelected.map((p) => p.name).join('、')}` : '批量删除所选环境'}
              onClick={() => setDeleteTarget({ names: selectedNames })}
            >
              🗑️ 批量删除
            </button>
          </>
        )}
        <button className="btn sm" onClick={() => void load()}>
          {t('btn.refresh')}
        </button>
        <button className="btn sm" onClick={() => void togglePorts()} title="查看当前运行端口与占用进程">
          🖧 端口
        </button>
      </div>

      {showPorts && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-title">
            🖧 运行端口
            <span className="spacer" />
            <button className="btn sm" onClick={() => void togglePorts()}>
              收起
            </button>
          </div>
          {ports === null ? (
            <p className="muted">加载中…</p>
          ) : ports.length === 0 ? (
            <p className="muted">当前没有运行中的环境</p>
          ) : (
            <div className="queue-list">
              {ports.map((p) => (
                <div className="queue-item done" key={p.profile}>
                  <span className="queue-status">🖧</span>
                  <span className="queue-name">{p.profile}</span>
                  <span className="badge running">端口 {p.port}</span>
                  <span className="muted">
                    {p.pid ? `PID ${p.pid}${p.processName ? `（${p.processName}）` : ''}` : '未监听'}
                  </span>
                  <span className="spacer" />
                  {p.url && (
                    <button
                      className="btn sm"
                      title={isTauri() ? '用 DSH Desktop 打开（无则用浏览器）' : '在新标签页打开'}
                      onClick={() => void openDsh(p)}
                    >
                      打开 ↗
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {profiles === null ? (
        <Loading />
      ) : profiles.length === 0 ? (
        <ErrorText message="未发现任何 Profile" />
      ) : (
        <div className="grid">
          {profiles.map((p) => (
            <div className={`card${selected.has(p.name) ? ' selected' : ''}`} key={p.name} onContextMenu={(e) => onContext(p, e)}>
              <div className="card-title">
                <label className="checkbox-wrap" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(p.name)} onChange={() => toggleSelect(p.name)} title="勾选后可用于批量删除" />
                  <span className="checkbox-label">{selected.has(p.name) ? '已选' : '选择'}</span>
                </label>
                {p.name}
                <span
                  className={`badge ${p.running ? 'running' : p.starting ? 'starting' : p.procError ? 'error' : 'stopped'}`}
                >
                  {p.running ? '运行中' : p.starting ? '启动中…' : p.procError ? '启动失败' : '已停止'}
                </span>
              </div>
              {p.starting && <p className="muted">启动阶段：spawn 进程 → 端口就绪检测（60s 超时）…</p>}
              {p.procError && (
                <div className="card" style={{ marginTop: 10, border: '1px solid rgba(239, 68, 68, 0.4)' }}>
                  <div className="card-title" style={{ color: 'var(--err)' }}>
                    ⚠ {p.procError}
                  </div>
                  <p className="muted">
                    常见原因：插件树加载失败（依赖缺失 / cordis.patch.yml 格式错误）、端口被占用、DSH 配置错误。请查看日志尾部：
                  </p>
                  <button className="btn sm" onClick={() => viewLog(p.name)}>
                    {logFor === p.name ? '收起日志' : '查看日志'}
                  </button>
                </div>
              )}
              <p className="card-sub">
                {p.exists ? `${p.bundles.length} 个 bundle · ${Object.keys(p.dependencies).length} 个依赖` : '（目录缺失）'}
                {p.port ? ` · 端口 ${p.port}` : ''}
              </p>
              {p.url && <p className="muted">地址：{p.url}</p>}
              {p.error && <p className="muted">⚠ {p.error}</p>}
              {dshInstances.length > 0 && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="muted">dsh 版本</span>
                  <select
                    className="select"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    value={byProfileVersion[p.name] ?? ''}
                    onChange={(e) => void setProfileVersion(p.name, e.target.value)}
                  >
                    <option value="">{t('common.default')}</option>
                    {dshInstances.map((inst) => (
                      <option key={inst.name} value={inst.name}>
                        {inst.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
                {p.running ? (
                  <button className="btn danger sm" disabled={busy === p.name} onClick={() => stop(p.name)}>
                    停止
                  </button>
                ) : (
                  <>
                    <button
                      className="btn primary sm"
                      disabled={busy === p.name || p.starting || !p.exists}
                      onClick={() => start(p.name)}
                    >
                      {p.starting ? '启动中…' : '启动'}
                    </button>
                    <input
                      className="input"
                      style={{ width: 110, padding: '5px 8px', fontSize: 12 }}
                      placeholder="端口(留空自动)"
                      title="自定义启动端口(1-65535)，留空自动找空闲端口"
                      value={customPort[p.name] ?? ''}
                      onChange={(e) => setCustomPort((prev) => ({ ...prev, [p.name]: e.target.value.replace(/[^\d]/g, '') }))}
                    />
                  </>
                )}
                <button className="btn sm" onClick={() => viewLog(p.name)}>
                  {logFor === p.name ? '收起日志' : '日志'}
                </button>
                {p.running && p.url && (
                  <button
                    className="btn sm"
                    title={isTauri() ? '用 DSH Desktop 打开（无则用浏览器）' : '在新标签页打开'}
                    onClick={() => void openDsh(p)}
                  >
                    打开 ↗
                  </button>
                )}
                <span className="spacer" />
                <button
                  className="btn danger sm delete-btn"
                  disabled={p.running || p.starting}
                  title={p.running || p.starting ? '请先停止环境再删除' : '删除环境（需输入环境名确认）'}
                  onClick={() => setDeleteTarget({ name: p.name })}
                >
                  🗑️
                </button>
              </div>
              {logFor === p.name && (
                <>
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="muted">每 3s 自动刷新</span>
                    <span className="spacer" />
                    <button className="btn sm" onClick={() => setPaused((v) => !v)}>
                      {paused ? '继续' : '暂停'}
                    </button>
                  </div>
                  <div className="log-panel" ref={logRef}>
                    {log || '（暂无日志）'}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteTarget?.name && (
        <ConfirmDialog
          title={`⚠️ 删除环境 ${deleteTarget.name}`}
          message={`确定要删除环境 ${deleteTarget.name} 吗？其目录将被整体移除，此操作不可撤销！`}
          danger
          requireText={deleteTarget.name}
          placeholder={`输入 "${deleteTarget.name}"`}
          confirmLabel="确认删除"
          busy={deleting}
          onConfirm={() => void confirmDeleteOne(deleteTarget.name!)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {deleteTarget?.names && (
        <ConfirmDialog
          title={`⚠️ 批量删除 ${deleteTarget.names.length} 个环境`}
          message={`确定要删除以下环境吗？其目录将被整体移除，此操作不可撤销！\n${deleteTarget.names.join('、')}`}
          danger
          requireText="DELETE"
          placeholder="输入 DELETE"
          confirmLabel="确认批量删除"
          busy={deleting}
          onConfirm={() => void confirmDeleteBatch(deleteTarget.names!)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
