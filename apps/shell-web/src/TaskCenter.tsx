import { useEffect, useRef, useState } from 'react'
import { taskManager, type GlobalTask } from './tasks'

export function TaskCenter() {
  const [tasks, setTasks] = useState<GlobalTask[]>([])
  const [open, setOpen] = useState(false)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    return taskManager.subscribe((all) => {
      setTasks(all)
      // 若有新任务启动且抽屉未打开，自动打开日志展开
      const running = all.find((t) => t.status === 'running' && !t.dismissed)
      if (running && !expandedLogId) {
        setExpandedLogId(running.id)
      }
    })
  }, [expandedLogId])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [tasks, expandedLogId])

  const visibleTasks = tasks.filter((t) => !t.dismissed)
  const runningTasks = visibleTasks.filter((t) => t.status === 'running')
  const hasRunning = runningTasks.length > 0

  if (visibleTasks.length === 0 && !open) {
    return null
  }

  return (
    <>
      {/* 右下角常驻悬浮微件 */}
      <div
        className="task-center-pill"
        onClick={() => setOpen((prev) => !prev)}
        title="全局任务中心：点击查看后台任务与实时日志"
      >
        <span className={`task-indicator ${hasRunning ? 'running' : 'idle'}`}>
          {hasRunning ? '🌀' : '📋'}
        </span>
        <span className="task-pill-text">
          {hasRunning
            ? `${runningTasks.length} 个任务运行中`
            : `${visibleTasks.length} 个任务`}
        </span>
      </div>

      {/* 展开的全局任务抽屉面板 */}
      {open && (
        <div className="task-center-drawer card">
          <div className="task-center-head">
            <div className="task-center-title">
              <span>📋 全局任务中心</span>
              {hasRunning && <span className="badge running">{runningTasks.length} 运行中</span>}
            </div>
            <div className="task-center-actions">
              <button
                className="btn sm"
                onClick={() => taskManager.clearFinished()}
                title="清空已完成与出错任务"
              >
                清空已完成
              </button>
              <button
                className="btn sm"
                onClick={() => setOpen(false)}
                title="最小化"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="task-center-body">
            {visibleTasks.length === 0 ? (
              <p className="muted" style={{ padding: '16px 0', textAlign: 'center' }}>
                当前暂无后台任务
              </p>
            ) : (
              visibleTasks.map((t) => {
                const isExpanded = expandedLogId === t.id
                return (
                  <div className="task-item card" key={t.id}>
                    <div className="task-item-head">
                      <strong className="task-title">{t.title}</strong>
                      <span
                        className={`badge ${
                          t.status === 'running'
                            ? 'running'
                            : t.status === 'done'
                            ? 'ok'
                            : 'error'
                        }`}
                      >
                        {t.status === 'running'
                          ? '运行中'
                          : t.status === 'done'
                          ? '已完成'
                          : '出错'}
                      </span>
                      <button
                        className="btn sm"
                        onClick={() =>
                          setExpandedLogId(isExpanded ? null : t.id)
                        }
                        title={isExpanded ? '收起日志' : '展开日志'}
                      >
                        {isExpanded ? '收起日志' : '查看日志'}
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => taskManager.dismissTask(t.id)}
                        title="隐藏此任务"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="progress-bar" style={{ marginTop: 8 }}>
                      <div
                        className={`progress-fill ${t.status}`}
                        style={{ width: `${t.progress}%` }}
                      />
                    </div>

                    {t.message && (
                      <p className="task-item-msg muted" style={{ marginTop: 4 }}>
                        {t.message}
                      </p>
                    )}

                    {isExpanded && (
                      <pre className="progress-log" ref={logRef} style={{ marginTop: 8 }}>
                        {t.log || '（等待日志输出…）'}
                      </pre>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </>
  )
}
