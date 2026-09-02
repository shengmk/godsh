import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DshInstance, Health, PortInfo, ProfileView, WorkflowTemplate, ProfilePackage } from '../types'
import { ConfirmDialog, ContextMenu, ErrorText, Loading, Toast, type MenuState } from '../components'
import { useToast } from '../hooks'
import { useI18n } from '../i18n'
import { isTauri, openDshWeb, openDshDesktop as openDshDesktopFn, openExternal } from '../tauri'
import { taskManager } from '../tasks'

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
  // 高级能力：配置化工作流与批量规则
  const [workflowsModalOpen, setWorkflowsModalOpen] = useState(false)
  const [wfList, setWfList] = useState<WorkflowTemplate[]>([])
  const [selectedWfId, setSelectedWfId] = useState<string>('developer-suite')
  const [wfTargetProfile, setWfTargetProfile] = useState<string>('')
  const [wfTab, setWfTab] = useState<'workflow' | 'sync'>('workflow')
  const [syncFromProfile, setSyncFromProfile] = useState<string>('')
  const [syncToProfile, setSyncToProfile] = useState<string>('')
  const [wfSubmitting, setWfSubmitting] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
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

  async function restart(name: string) {
    setBusy(name)
    const portText = (customPort[name] ?? '').trim()
    const port = portText ? Number.parseInt(portText, 10) : undefined
    try {
      await api.restartProfile(name, port)
      show(`正在重启 ${name}…`)
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

  /** 打开环境（默认入口）：用系统浏览器打开 godsh 启动的 web 界面（端口即自定义端口，零冲突）。 */
  async function openDsh(p: { name?: string; profile?: string; url: string | null }) {
    const label = p.name ?? p.profile ?? 'dsh'
    if (!p.url) return show('环境未运行或地址不可用', true)
    try {
      await openDshWeb(p.url)
      show(`已在浏览器打开 ${label}（${p.url}）`)
    } catch (e) {
      show(`打开失败：${e instanceof Error ? e.message : String(e)}`, true)
    }
  }



  /** 导出环境完整配置包（JSON） */
  async function exportEnv(name: string) {
    try {
      const pkg = await api.exportProfile(name)
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `godsh-env-${name}-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      show(`已导出环境包：${name}`)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 从本地 JSON 文件导入环境包 */
  async function handleImportFile(file: File) {
    try {
      const text = await file.text()
      const pkg = JSON.parse(text) as ProfilePackage
      if (!pkg || typeof pkg !== 'object' || !pkg.name) {
        show('非法环境包文件：缺少必要字段', true)
        return
      }
      const targetName = window.prompt(`请输入导入后的环境名（原环境名：${pkg.name}）：`, pkg.name)
      if (!targetName) return
      const res = await api.importProfile({ targetName: targetName.trim(), package: pkg })
      show(`已成功导入环境 ${res.profile}${res.dependenciesCount ? `（正在准备 ${res.dependenciesCount} 个依赖）` : ''}`)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  /** 加载预设工作流列表 */
  async function openWorkflowsModal() {
    setWorkflowsModalOpen(true)
    try {
      const list = await api.workflows()
      setWfList(list)
      if (list.length > 0 && !selectedWfId) {
        setSelectedWfId(list[0]!.id)
        setWfTargetProfile(list[0]!.recommendedProfile)
      }
      if (profiles && profiles.length > 0) {
        if (!syncFromProfile) setSyncFromProfile(profiles[0]!.name)
        if (!syncToProfile && profiles.length > 1) setSyncToProfile(profiles[1]!.name)
      }
    } catch {
      /* ignore */
    }
  }

  /** 触发工作流执行（并在全局任务中心追踪实时日志） */
  async function handleRunWorkflow() {
    if (!selectedWfId) return
    const target = wfTargetProfile.trim() || undefined
    setWfSubmitting(true)
    try {
      const res = await taskManager.startWorkflowTask(selectedWfId, target, (ok) => {
        void load()
        show(ok ? '工作流执行完毕！' : '工作流执行遇到警告或部分步骤未成功，请查看任务中心日志', !ok)
      })
      if (!res.ok) {
        show(res.message || '启动工作流失败', true)
        return
      }
      show(`已触发工作流：${res.title}，可在全局任务中心查看实时进度`)
      setWorkflowsModalOpen(false)
      setTimeout(load, 1500)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setWfSubmitting(false)
    }
  }

  /** 批量规则：环境间克隆同步 */
  async function handleBatchSync() {
    if (!syncFromProfile || !syncToProfile) return show('请选择源环境与目标环境', true)
    if (syncFromProfile === syncToProfile) return show('源环境与目标环境不能相同', true)
    if (!window.confirm(`确定将环境 ${syncFromProfile} 的全部 bundles 与插件分配规则同步到 ${syncToProfile}？`)) return
    setWfSubmitting(true)
    try {
      const r = await api.syncProfileAllocations(syncFromProfile, syncToProfile)
      show(`成功克隆！已同步 ${r.copiedAllocations} 项分配到 ${r.toProfile}`)
      setWorkflowsModalOpen(false)
      await load()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    } finally {
      setWfSubmitting(false)
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
        p.running
          ? { label: '重启', onClick: () => void restart(p.name) }
          : { label: '重启', disabled: true, onClick: () => {} },
        p.running && p.url
          ? { label: '打开应用窗口（网址应用化）', onClick: () => void openDsh(p) }
          : { label: '打开应用窗口（网址应用化）', disabled: true, onClick: () => {} },
        isTauri() && p.running
          ? { label: '用 DSH Desktop 打开', onClick: () => void openDshDesktopFn(p.name) }
          : { label: '用 DSH Desktop 打开', disabled: true, onClick: () => {} },
        p.running && p.url
          ? { label: '在系统浏览器打开', onClick: () => void openExternal(p.url!) }
          : { label: '在系统浏览器打开', disabled: true, onClick: () => {} },
        { label: '查看日志', onClick: () => viewLog(p.name) },
        { separator: true, label: '', onClick: () => {} },
        p.port ? { label: `复制端口 ${p.port}`, onClick: () => void copy(String(p.port), '端口') } : { label: '复制端口', disabled: true, onClick: () => {} },
        p.url ? { label: '复制地址', onClick: () => void copy(p.url!, '地址') } : { label: '复制地址', disabled: true, onClick: () => {} },
        { separator: true, label: '', onClick: () => {} },
        { label: '📤 导出环境包 (JSON)', onClick: () => void exportEnv(p.name) },
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
        <button
          className="btn sm"
          onClick={() => importInputRef.current?.click()}
          title="从 JSON 环境配置包一键导入新环境"
        >
          📥 导入环境包
        </button>
        <button
          className="btn sm"
          onClick={() => void openWorkflowsModal()}
          title="打开配置化工作流与批量规则面板"
        >
          ⚡ 工作流 / 规则
        </button>
        <button className="btn sm" onClick={() => void togglePorts()} title="查看当前运行端口与占用进程">
          🖧 端口
        </button>
        <input
          type="file"
          ref={importInputRef}
          style={{ display: 'none' }}
          accept=".json"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportFile(f)
            e.target.value = ''
          }}
        />
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
                      title='浏览器应用窗口打开（网址应用化，独立窗口）'
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
                  <>
                    <button className="btn danger sm" disabled={busy === p.name} onClick={() => stop(p.name)}>
                      停止
                    </button>
                    <button
                      className="btn sm"
                      disabled={busy === p.name}
                      title="重启该环境（释放并重新监听端口）"
                      onClick={() => void restart(p.name)}
                    >
                      🔄 重启
                    </button>
                  </>
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
                    title='浏览器应用窗口打开（网址应用化，独立窗口）'
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

      {/* 工作流与批量规则模态框 */}
      {workflowsModalOpen && (
        <div className="modal-overlay" onClick={() => setWorkflowsModalOpen(false)}>
          <div className="modal glass" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 className="modal-title" style={{ margin: 0 }}>⚡ 工作流与批量规则</h3>
              <button className="btn sm" onClick={() => setWorkflowsModalOpen(false)}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                className={`btn sm ${wfTab === 'workflow' ? 'primary' : ''}`}
                onClick={() => setWfTab('workflow')}
              >
                内置工作流
              </button>
              <button
                className={`btn sm ${wfTab === 'sync' ? 'primary' : ''}`}
                onClick={() => setWfTab('sync')}
              >
                环境克隆与规则同步
              </button>
            </div>

            {wfTab === 'workflow' ? (
              <div>
                <label className="field-label">选择工作流模板：</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6, marginBottom: 14 }}>
                  {wfList.map((w) => (
                    <div
                      key={w.id}
                      className={`card ${selectedWfId === w.id ? 'selected' : ''}`}
                      style={{
                        padding: 10,
                        cursor: 'pointer',
                        borderColor: selectedWfId === w.id ? 'var(--brand-1)' : undefined,
                      }}
                      onClick={() => {
                        setSelectedWfId(w.id)
                        if (!wfTargetProfile) setWfTargetProfile(w.recommendedProfile)
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{w.name}</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{w.desc}</div>
                    </div>
                  ))}
                </div>

                <label className="field-label">目标环境名（留空使用默认）：</label>
                <input
                  className="input"
                  style={{ width: '100%', marginTop: 4, marginBottom: 16 }}
                  placeholder="目标环境名（如 dev-workspace）"
                  value={wfTargetProfile}
                  onChange={(e) => setWfTargetProfile(e.target.value)}
                />

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn" onClick={() => setWorkflowsModalOpen(false)}>取消</button>
                  <button
                    className="btn primary"
                    disabled={wfSubmitting}
                    onClick={() => void handleRunWorkflow()}
                  >
                    {wfSubmitting ? '启动中…' : '▶ 执行工作流'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
                  将源环境的所有 bundles 列表与插件分配规则 1:1 克隆并应用到目标环境。
                </p>
                <label className="field-label">源环境（被复制）：</label>
                <select
                  className="input"
                  style={{ width: '100%', marginTop: 4, marginBottom: 12 }}
                  value={syncFromProfile}
                  onChange={(e) => setSyncFromProfile(e.target.value)}
                >
                  {(profiles ?? []).map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>

                <label className="field-label">目标环境（接受同步）：</label>
                <select
                  className="input"
                  style={{ width: '100%', marginTop: 4, marginBottom: 16 }}
                  value={syncToProfile}
                  onChange={(e) => setSyncToProfile(e.target.value)}
                >
                  {(profiles ?? []).map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn" onClick={() => setWorkflowsModalOpen(false)}>取消</button>
                  <button
                    className="btn primary"
                    disabled={wfSubmitting || !syncFromProfile || !syncToProfile || syncFromProfile === syncToProfile}
                    onClick={() => void handleBatchSync()}
                  >
                    {wfSubmitting ? '同步中…' : '⚡ 开始同步克隆'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {toast && <Toast text={toast.text} error={toast.error} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
