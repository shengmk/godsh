import { api } from './api'

export type TaskType = 'update-all' | 'batch-install' | 'workflow' | 'import-profile' | 'dsh-install'
export type TaskStatus = 'running' | 'done' | 'error'

export interface GlobalTask {
  id: string
  type: TaskType
  title: string
  profile?: string
  status: TaskStatus
  log: string
  progress: number // 0-100
  message?: string
  createdAt: number
  updatedAt: number
  dismissed?: boolean
}

type TaskListener = (tasks: GlobalTask[]) => void

class TaskManager {
  private tasks: Map<string, GlobalTask> = new Map()
  private listeners: Set<TaskListener> = new Set()
  private activePolls: Map<string, ReturnType<typeof setInterval>> = new Map()

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener)
    listener(this.getAll())
    return () => this.listeners.delete(listener)
  }

  private notify() {
    const list = this.getAll()
    for (const l of this.listeners) {
      l(list)
    }
  }

  getAll(): GlobalTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  getActiveCount(): number {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'running' && !t.dismissed).length
  }

  getTask(id: string): GlobalTask | undefined {
    return this.tasks.get(id)
  }

  addTask(task: Omit<GlobalTask, 'createdAt' | 'updatedAt' | 'progress'> & { progress?: number }): GlobalTask {
    const now = Date.now()
    const full: GlobalTask = {
      ...task,
      progress: task.progress ?? (task.status === 'running' ? 20 : 100),
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, full)
    this.notify()
    return full
  }

  updateTask(id: string, patch: Partial<Omit<GlobalTask, 'id' | 'createdAt'>>) {
    const existing = this.tasks.get(id)
    if (!existing) return
    const updated: GlobalTask = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    this.tasks.set(id, updated)
    this.notify()
  }

  dismissTask(id: string) {
    const t = this.tasks.get(id)
    if (t) {
      t.dismissed = true
      this.notify()
    }
  }

  clearFinished() {
    for (const [id, t] of this.tasks.entries()) {
      if (t.status !== 'running') {
        this.tasks.delete(id)
      }
    }
    this.notify()
  }

  /**
   * 启动环境全部插件更新后台任务并接管全局轮询
   */
  async startUpdateAllTask(profile: string, onDone?: (ok: boolean) => void): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await api.updateAllPlugins(profile)
      if (!res.task) {
        return { ok: false, message: res.message || '没有可更新的插件' }
      }

      const taskId = res.task
      this.addTask({
        id: taskId,
        type: 'update-all',
        title: `更新环境 ${profile} 全部插件`,
        profile,
        status: 'running',
        log: '准备中…\n',
        progress: 10,
      })

      // 启动全局轮询（独立于任何页面，换页不中断）
      const poll = setInterval(async () => {
        try {
          const p = await api.updateAllProgress(profile, taskId)
          const isFinished = p.status !== 'running'
          this.updateTask(taskId, {
            log: p.log,
            status: (p.status as TaskStatus) || 'running',
            progress: isFinished ? 100 : 50,
            message: p.message,
          })

          if (isFinished) {
            clearInterval(poll)
            this.activePolls.delete(taskId)
            onDone?.(p.status === 'done')
          }
        } catch {
          // 轮询异常继续尝试
        }
      }, 1500)

      this.activePolls.set(taskId, poll)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
}

export const taskManager = new TaskManager()
