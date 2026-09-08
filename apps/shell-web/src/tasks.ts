import { api } from './api'

export type TaskType =
  | 'update-all'
  | 'batch-install'
  | 'workflow'
  | 'import-profile'
  | 'dsh-install'
  | 'vault-update-all'
  | 'vault-update'
export type TaskStatus = 'running' | 'done' | 'error'

function sendDesktopNotice(title: string, body?: string) {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body })
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            new Notification(title, { body })
          }
        })
      }
    }
  } catch {
    // 忽略通知权限异常
  }
}

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

  /**
   * 启动工作流后台任务并接管全局轮询与流式回显
   */
  async startWorkflowTask(
    workflowId: string,
    profile?: string,
    onDone?: (ok: boolean) => void,
  ): Promise<{ ok: boolean; task?: string; title?: string; message?: string }> {
    try {
      const res = await api.runWorkflow({ workflowId, profile })
      if (!res.task) {
        return { ok: false, message: '未能创建工作流任务' }
      }

      const taskId = res.task
      this.addTask({
        id: taskId,
        type: 'workflow',
        title: res.title,
        profile,
        status: 'running',
        log: '工作流已启动，正在准备执行环境…\n',
        progress: 10,
      })

      // 启动全局轮询（1 秒高频轮询，驱动任务中心实时刷新）
      const poll = setInterval(async () => {
        try {
          const p = await api.getWorkflowProgress(taskId)
          const isFinished = p.status !== 'running'

          // 解析日志中的进度标记如 [1/3] -> 33%, [2/3] -> 66%
          let calculatedProgress = 20
          const matches = p.log.match(/\[(\d+)\/(\d+)\]/g)
          if (matches && matches.length > 0) {
            const last = matches[matches.length - 1]
            const m = /\[(\d+)\/(\d+)\]/.exec(last)
            if (m) {
              const cur = Number(m[1])
              const total = Number(m[2])
              calculatedProgress = Math.min(95, Math.round((cur / (total + 0.5)) * 100))
            }
          }

          this.updateTask(taskId, {
            log: p.log,
            status: (p.status as TaskStatus) || 'running',
            progress: isFinished ? 100 : calculatedProgress,
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
      }, 1000)

      this.activePolls.set(taskId, poll)
      return { ok: true, task: taskId, title: res.title }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 启动沙箱插件全量更新后台任务并接管全局工作栏轮询
   */
  async startVaultUpdateAllTask(
    onDone?: (ok: boolean) => void,
  ): Promise<{ ok: boolean; task?: string; message?: string }> {
    try {
      const res = await api.vaultUpdateAllAsync()
      if (!res.task) {
        return { ok: false, message: res.message || '启动沙箱自动更新任务失败' }
      }

      const taskId = res.task
      this.addTask({
        id: taskId,
        type: 'vault-update-all',
        title: '沙箱插件全量自动更新',
        status: 'running',
        log: '任务已启动，正在比对版本并准备下载…\n',
        progress: 10,
      })

      // 启动全局轮询（1 秒高频轮询）
      const poll = setInterval(async () => {
        try {
          const p = await api.vaultTaskProgress(taskId)
          const isFinished = p.status !== 'running'

          // 解析日志中的插件更新进度
          let calculatedProgress = 15
          const pluginMatches = Array.from(p.log.matchAll(/\[(\d+)\/(\d+)\]\s*升级插件/g))
          if (pluginMatches.length > 0) {
            const last = pluginMatches[pluginMatches.length - 1]
            const cur = Number(last[1])
            const total = Number(last[2])
            const base = ((cur - 1) / total) * 80 + 15
            // 匹配子步骤 [1/4]..[4/4]
            const subMatches = Array.from(p.log.matchAll(/\[([1-4])\/4\]/g))
            const sub = subMatches.length > 0 ? Number(subMatches[subMatches.length - 1][1]) : 1
            const subProgress = ((sub - 1) / 4) * (80 / total)
            calculatedProgress = Math.min(95, Math.round(base + subProgress))
          } else if (p.log.includes('所有沙箱插件均已是最新版本')) {
            calculatedProgress = 100
          }

          this.updateTask(taskId, {
            log: p.log,
            status: (p.status as TaskStatus) || 'running',
            progress: isFinished ? 100 : calculatedProgress,
            message: p.message,
          })

          if (isFinished) {
            clearInterval(poll)
            this.activePolls.delete(taskId)
            const success = p.status === 'done'
            sendDesktopNotice(
              success ? '沙箱插件全量更新已完成' : '沙箱插件更新异常',
              success ? '已成功解包并同步至各挂载环境' : (p.message || '部分插件更新过程中出现错误')
            )
            onDone?.(success)
          }
        } catch {
          // 轮询异常继续尝试
        }
      }, 1000)

      this.activePolls.set(taskId, poll)
      return { ok: true, task: taskId }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 启动单插件拉取升级后台任务并接管全局工作栏轮询
   */
  async startVaultUpdatePluginTask(
    id: string,
    name?: string,
    version?: string,
    onDone?: (ok: boolean) => void,
  ): Promise<{ ok: boolean; task?: string; message?: string }> {
    try {
      const res = await api.vaultUpdatePluginAsync(id, version)
      if (!res.task) {
        return { ok: false, message: res.message || `启动插件 ${name || id} 更新失败` }
      }

      const taskId = res.task
      const pluginTitle = name || id
      this.addTask({
        id: taskId,
        type: 'vault-update',
        title: `升级沙箱插件 ${pluginTitle}${version ? ` (v${version})` : ''}`,
        status: 'running',
        log: `准备拉取升级 ${pluginTitle} 至 ${version || '最新版本'}…\n`,
        progress: 15,
      })

      // 启动全局轮询（1 秒高频轮询）
      const poll = setInterval(async () => {
        try {
          const p = await api.vaultTaskProgress(taskId)
          const isFinished = p.status !== 'running'

          // 解析子步骤 [1/4]..[4/4] 进度
          let calculatedProgress = 20
          const subMatches = Array.from(p.log.matchAll(/\[([1-4])\/4\]/g))
          if (subMatches.length > 0) {
            const step = Number(subMatches[subMatches.length - 1][1])
            calculatedProgress = Math.min(95, 20 + step * 18)
          }

          this.updateTask(taskId, {
            log: p.log,
            status: (p.status as TaskStatus) || 'running',
            progress: isFinished ? 100 : calculatedProgress,
            message: p.message,
          })

          if (isFinished) {
            clearInterval(poll)
            this.activePolls.delete(taskId)
            const success = p.status === 'done'
            sendDesktopNotice(
              success ? `插件 ${pluginTitle} 升级成功` : `插件 ${pluginTitle} 升级失败`,
              success ? `已升级至 ${version || '最新版本'} 并刷新挂载软链` : (p.message || '更新过程中出现错误')
            )
            onDone?.(success)
          }
        } catch {
          // 轮询异常继续尝试
        }
      }, 1000)

      this.activePolls.set(taskId, poll)
      return { ok: true, task: taskId }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
}

export const taskManager = new TaskManager()
