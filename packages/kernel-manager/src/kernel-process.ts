import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { run, type ConfigStore, getPortStatus, startWeb, stopWeb } from '@dsh-launcher/core'
import { findTemplate } from './kernel-template.js'
import type { KernelInstance, KernelTemplate } from './types.js'

interface KernelsFile {
  kernels: KernelInstance[]
}

export interface CreateKernelOptions {
  templateId: string
  name?: string
  profile?: string
  port?: number
}

/** 内核实例管理，持久化到 data/kernels.json。 */
export class KernelManager {
  private static FILE = 'kernels.json'

  /**
   * 持有运行中 web 内核的子进程引用（key = kernel id），
   * 防止 ChildProcess 被 GC 后无法收到 close 事件、无法精确终止。
   */
  private children = new Map<string, ChildProcess>()

  constructor(
    private store: ConfigStore,
    private templatesDir: string,
    private logDir: string,
    private pidDir: string,
  ) {}

  list(): KernelInstance[] {
    return this.store.read<KernelsFile>(KernelManager.FILE, { kernels: [] }).kernels
  }

  get(id: string): KernelInstance | null {
    return this.list().find((k) => k.id === id) ?? null
  }

  private save(kernels: KernelInstance[]): void {
    this.store.write<KernelsFile>(KernelManager.FILE, { kernels })
  }

  create(opts: CreateKernelOptions): KernelInstance {
    const template = findTemplate(this.templatesDir, opts.templateId)
    if (!template) throw new Error(`内核模板不存在: ${opts.templateId}`)

    const instance: KernelInstance = {
      id: randomUUID(),
      templateId: template.id,
      name: opts.name ?? `${template.id}-${Date.now().toString(36)}`,
      profile: opts.profile,
      port: opts.port ?? template.defaultPort,
      status: 'stopped',
      pid: null,
      createdAt: new Date().toISOString(),
    }

    const kernels = this.list()
    kernels.push(instance)
    this.save(kernels)
    return instance
  }

  async start(id: string, dshBin?: string): Promise<KernelInstance> {
    const kernels = this.list()
    const instance = kernels.find((k) => k.id === id)
    if (!instance) throw new Error(`内核实例不存在: ${id}`)
    const template = findTemplate(this.templatesDir, instance.templateId)
    if (!template) throw new Error(`内核模板缺失: ${instance.templateId}`)

    instance.status = 'starting'
    instance.error = undefined
    this.save(kernels)

    try {
      if (template.type === 'web') {
        if (!instance.profile) throw new Error('web 内核需要指定关联 Profile')
        if (!instance.port) throw new Error('web 内核需要指定端口')
        const { info, child } = await startWeb({
          profile: instance.profile,
          port: instance.port,
          logDir: this.logDir,
          pidDir: this.pidDir,
          dshBin,
        })
        // 持有 child 引用，防止被 GC；stop() 负责终止并清理
        this.children.set(id, child)
        child.on('close', () => {
          if (this.children.get(id) === child) this.children.delete(id)
        })
        instance.status = info.running ? 'running' : 'error'
        instance.pid = info.pid
        if (!info.running) instance.error = '服务未在超时时间内就绪'
      } else {
        const args = this.resolveHeadlessArgs(template, instance)
        const r = await run('dsh', args)
        instance.status = r.ok ? 'running' : 'error'
        instance.error = r.ok ? undefined : (r.stderr || r.stdout || '启动失败')
      }
    } catch (err) {
      instance.status = 'error'
      instance.error = err instanceof Error ? err.message : String(err)
    }

    this.save(kernels)
    return instance
  }

  async stop(id: string): Promise<KernelInstance> {
    const kernels = this.list()
    const instance = kernels.find((k) => k.id === id)
    if (!instance) throw new Error(`内核实例不存在: ${id}`)

    // 先优雅终止持有的子进程，再按 pid 文件兜底
    const child = this.children.get(id)
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }
    if (instance.port && instance.pid) {
      await stopWeb(this.pidDir, instance.port)
    }
    this.children.delete(id)
    instance.status = 'stopped'
    instance.pid = null
    this.save(kernels)
    return instance
  }

  remove(id: string): void {
    const kernels = this.list()
    const instance = kernels.find((k) => k.id === id)
    if (!instance) throw new Error(`内核实例不存在: ${id}`)
    if (instance.status !== 'stopped') throw new Error('请先停止内核实例再删除')
    this.children.delete(id)
    this.save(kernels.filter((k) => k.id !== id))
  }

  /** 根据 pid 文件刷新运行状态。 */
  async refreshStatus(): Promise<void> {
    const kernels = this.list()
    let changed = false
    for (const k of kernels) {
      if (k.port) {
        const { running, pid } = await getPortStatus(this.pidDir, k.port)
        const nextStatus = running ? 'running' : k.status === 'starting' ? 'starting' : 'stopped'
        if (k.status !== nextStatus || k.pid !== pid) {
          k.status = nextStatus
          k.pid = pid
          changed = true
        }
      }
    }
    if (changed) this.save(kernels)
  }

  private resolveHeadlessArgs(template: KernelTemplate, instance: KernelInstance): string[] {
    if (template.command?.length) {
      return template.command.map((token) =>
        token.replace('{profile}', instance.profile ?? '').replace('{port}', String(instance.port ?? '')),
      )
    }
    const args = ['--profile', instance.profile ?? '']
    if (instance.port) args.push('--port', String(instance.port))
    return args
  }
}
