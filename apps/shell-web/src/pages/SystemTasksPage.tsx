import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { SystemTaskItem, JournalEntryItem } from '../types'

export default function SystemTasksPage() {
  const [tasks, setTasks] = useState<SystemTaskItem[]>([])
  const [journal, setJournal] = useState<JournalEntryItem[]>([])
  const [activeTab, setActiveTab] = useState<'tasks' | 'journal'>('tasks')
  const [filterStatus, setFilterStatus] = useState<'all' | 'running' | 'done' | 'error'>('all')
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null)
  const [taskDetail, setTaskDetail] = useState<{ status: string; log: string; message?: string } | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const terminalRef = useRef<HTMLPreElement | null>(null)

  const loadData = async () => {
    try {
      const [tasksRes, journalRes] = await Promise.all([
        api.systemTasks().catch(() => ({ tasks: [], count: 0 })),
        api.journalEntries(undefined, undefined, 100).catch(() => ({ entries: [] })),
      ])
      setTasks(tasksRes.tasks || [])
      setJournal(journalRes.entries || [])

      // 默认选中第一个任务
      if (!selectedTaskKey && tasksRes.tasks && tasksRes.tasks.length > 0) {
        setSelectedTaskKey(tasksRes.tasks[0]!.key)
      }
    } catch {}
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 3000)
    return () => clearInterval(interval)
  }, [])

  // 轮询当前选中任务的实时日志
  useEffect(() => {
    if (!selectedTaskKey) {
      setTaskDetail(null)
      return
    }
    let cancelled = false
    const pollDetail = async () => {
      try {
        const detail = await api.systemTaskDetail(selectedTaskKey)
        if (!cancelled) {
          setTaskDetail(detail)
          if (autoScroll && terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight
          }
        }
      } catch {
        if (!cancelled) setTaskDetail(null)
      }
    }

    pollDetail()
    const tInterval = setInterval(pollDetail, 1500)
    return () => {
      cancelled = true
      clearInterval(tInterval)
    }
  }, [selectedTaskKey, autoScroll])

  const handleClearTasks = async () => {
    try {
      await api.systemTasksClear()
      await loadData()
      setSelectedTaskKey(null)
      setTaskDetail(null)
    } catch {}
  }

  const handleClearJournal = async () => {
    try {
      await api.journalClear()
      await loadData()
    } catch {}
  }

  const filteredTasks = tasks.filter((t) => {
    if (filterStatus === 'all') return true
    return t.status === filterStatus
  })

  const getTaskBadge = (type: string) => {
    switch (type) {
      case 'repair':
        return { label: '自愈修复', color: 'badge-repair' }
      case 'vault':
        return { label: '沙箱升级', color: 'badge-vault' }
      case 'plugin-update':
        return { label: '插件更新', color: 'badge-plugin' }
      case 'install':
        return { label: '环境安装', color: 'badge-install' }
      case 'workflow':
        return { label: '批量任务', color: 'badge-workflow' }
      default:
        return { label: '系统任务', color: 'badge-default' }
    }
  }

  return (
    <div className="page tasks-page">
      {/* 头部区 */}
      <div className="page-header flex-between">
        <div>
          <h2 className="page-title">系统任务与工作进程中心</h2>
          <p className="page-desc">
            全维后台执行观测 · 7 阶段环境自愈 · 插件升级 · 原子回滚审计与实时日志终端
          </p>
        </div>
        <div className="actions-row">
          <div className="tab-pill-group">
            <button
              className={`pill-btn ${activeTab === 'tasks' ? 'active' : ''}`}
              onClick={() => setActiveTab('tasks')}
            >
              运行任务 ({tasks.length})
            </button>
            <button
              className={`pill-btn ${activeTab === 'journal' ? 'active' : ''}`}
              onClick={() => setActiveTab('journal')}
            >
              审计日记 ({journal.length})
            </button>
          </div>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              setRefreshing(true)
              await loadData()
              setTimeout(() => setRefreshing(false), 500)
            }}
            disabled={refreshing}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          {activeTab === 'tasks' ? (
            <button className="btn btn-danger-outline" onClick={handleClearTasks}>
              清理历史
            </button>
          ) : (
            <button className="btn btn-danger-outline" onClick={handleClearJournal}>
              清空日记
            </button>
          )}
        </div>
      </div>

      {activeTab === 'tasks' ? (
        <div className="tasks-dashboard-layout">
          {/* 左侧任务列表 */}
          <div className="tasks-sidebar panel glass">
            <div className="tasks-filter-bar">
              {(['all', 'running', 'done', 'error'] as const).map((st) => (
                <button
                  key={st}
                  className={`filter-tag ${filterStatus === st ? 'active' : ''}`}
                  onClick={() => setFilterStatus(st)}
                >
                  {st === 'all' && `全部 (${tasks.length})`}
                  {st === 'running' && `进行中 (${tasks.filter((x) => x.status === 'running').length})`}
                  {st === 'done' && `完成 (${tasks.filter((x) => x.status === 'done').length})`}
                  {st === 'error' && `失败 (${tasks.filter((x) => x.status === 'error').length})`}
                </button>
              ))}
            </div>

            <div className="tasks-list">
              {filteredTasks.length === 0 ? (
                <div className="empty-tasks">暂无符合条件的任务</div>
              ) : (
                filteredTasks.map((t) => {
                  const b = getTaskBadge(t.type)
                  const isSelected = selectedTaskKey === t.key
                  return (
                    <div
                      key={t.key}
                      className={`task-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedTaskKey(t.key)}
                    >
                      <div className="task-card-header flex-between">
                        <span className={`task-badge ${b.color}`}>{b.label}</span>
                        <span className={`status-pill status-${t.status}`}>
                          {t.status === 'running' && '● 运行中'}
                          {t.status === 'done' && '✓ 完成'}
                          {t.status === 'error' && '✗ 失败'}
                        </span>
                      </div>
                      <div className="task-card-title" title={t.key}>
                        {t.key}
                      </div>
                      {t.message && <div className="task-card-msg">{t.message}</div>}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* 右侧终端输出 */}
          <div className="terminal-panel panel glass">
            <div className="terminal-header flex-between">
              <div className="terminal-info">
                <span className="terminal-dot red" />
                <span className="terminal-dot yellow" />
                <span className="terminal-dot green" />
                <span className="terminal-title">
                  {selectedTaskKey ? `终端输出: ${selectedTaskKey}` : '终端日志'}
                </span>
              </div>
              <div className="terminal-controls">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                  />
                  <span>自动滚动</span>
                </label>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (taskDetail?.log) {
                      navigator.clipboard.writeText(taskDetail.log)
                    }
                  }}
                  disabled={!taskDetail?.log}
                >
                  复制
                </button>
              </div>
            </div>

            <pre className="terminal-body" ref={terminalRef}>
              {taskDetail ? (
                taskDetail.log || '(暂无日志输出…)'
              ) : selectedTaskKey ? (
                '正在加载日志…'
              ) : (
                '请从左侧选择任务查看实时执行日志'
              )}
            </pre>
          </div>
        </div>
      ) : (
        /* 审计日记视图 */
        <div className="journal-panel panel glass">
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>级别</th>
                  <th>模块</th>
                  <th>环境</th>
                  <th>操作</th>
                  <th>状态</th>
                  <th>详细信息</th>
                </tr>
              </thead>
              <tbody>
                {journal.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center muted py-4">
                      暂无审计日记记录
                    </td>
                  </tr>
                ) : (
                  journal.map((j, idx) => (
                    <tr key={idx}>
                      <td className="mono-cell">{j.isoTime ? j.isoTime.replace('T', ' ').slice(0, 19) : '—'}</td>
                      <td>
                        <span className={`status-pill status-${j.level}`}>{j.level.toUpperCase()}</span>
                      </td>
                      <td>
                        <span className="category-tag">{j.category}</span>
                      </td>
                      <td>{j.profile || '—'}</td>
                      <td className="bold">{j.action}</td>
                      <td>
                        <span className={`status-pill status-${j.status}`}>
                          {j.status === 'success' ? '成功' : j.status === 'failed' ? '失败' : j.status}
                        </span>
                      </td>
                      <td className="details-cell muted" title={j.details}>
                        {j.details || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
