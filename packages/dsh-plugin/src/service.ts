import { join } from 'node:path'
import { PatchManager } from './patch-manager.js'
import { BackupManager } from './backup-manager.js'
import { MemoryEngine } from './memory-engine.js'
import { WorkflowRunner, type WorkflowStep } from './workflow-runner.js'
import { AllocationManager } from '@godsh/allocation'
import { scanProfiles } from '@godsh/profile-manager'
import { ConfigStore } from '@godsh/core'
import type { CordisContext, AgentToolSchema, SnapshotMeta, MemoryPattern } from './types.js'

export interface GodshServiceOptions {
  profilesDir: string
  dataDir?: string
  backupDir?: string
  memoryDir?: string
  allocations?: AllocationManager
  applyAllocationFn?: (profile: string) => void
  getMarket?: () => Promise<unknown[]>
}

/**
 * GodshService：DSH/Cordis 原生服务核心，挂载至 ctx.godsh
 * 既支持 AI 对话 Tools 动态调用，又支持 Client UI RPC 极速响应
 */
export class GodshService {
  public patch: PatchManager
  public backup: BackupManager
  public memory: MemoryEngine
  public workflow: WorkflowRunner
  public allocations: AllocationManager

  constructor(public ctx: CordisContext, public opts: GodshServiceOptions) {
    const dataDir = opts.dataDir || join(opts.profilesDir, '..', 'data')
    const backupDir = opts.backupDir || join(opts.profilesDir, '..', 'backups')
    const memoryDir = opts.memoryDir || join(opts.profilesDir, '..', 'memory')

    this.allocations = opts.allocations || new AllocationManager(new ConfigStore(dataDir))
    this.patch = new PatchManager(opts.profilesDir)
    this.backup = new BackupManager(opts.profilesDir, backupDir)
    this.memory = new MemoryEngine(memoryDir)
    this.workflow = new WorkflowRunner(opts.profilesDir, this.allocations, opts.applyAllocationFn)

    this.registerAgentTools()
    this.hookLifecycleEvents()
    this.setupRpcEndpoints()
  }

  /**
   * 1. 注册 4 大 Agent 动态工具
   */
  public registerAgentTools(): AgentToolSchema[] {
    const tools: AgentToolSchema[] = [
      {
        name: 'godsh_list_profiles',
        description: '获取当前所有已安装环境 (Profiles)、bundles 与插件配置清单',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: '环境名模糊过滤关键字' },
          },
        },
        handler: async (args) => {
          const all = scanProfiles(this.opts.profilesDir)
          const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : ''
          const filtered = filter ? all.filter((p) => p.name.toLowerCase().includes(filter)) : all
          return filtered.map((p) => ({
            name: p.name,
            bundles: p.bundles,
            dependenciesCount: Object.keys(p.dependencies ?? {}).length,
            dependencies: Object.keys(p.dependencies ?? {}),
          }))
        },
      },
      {
        name: 'godsh_workflow_execute',
        description: '执行自动化环境构建与插件批量安装工作流',
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: '工作流 ID (developer-suite | ai-agent-suite | minimal-clean)' },
            targetProfile: { type: 'string', description: '目标环境名称' },
          },
          required: ['workflowId'],
        },
        handler: async (args) => {
          const wfId = String(args.workflowId)
          const target = String(args.targetProfile || 'dev-workspace')
          this.memory.recordPattern({
            profile: target,
            type: 'workflow',
            action: `run_workflow:${wfId}`,
            details: { workflowId: wfId, targetProfile: target },
            summary: `执行了 ${wfId} 工作流构建环境 ${target}`,
          })
          return { ok: true, message: `工作流 ${wfId} 已在环境 ${target} 启动执行` }
        },
      },
      {
        name: 'godsh_toggle_plugin_hot',
        description: '通过零重启修改 cordis.patch.yml 热启用或热禁用环境中的插件',
        parameters: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: '环境名称' },
            pluginId: { type: 'string', description: '插件包名或 ID' },
            enabled: { type: 'string', enum: ['true', 'false'], description: '是否启用' },
          },
          required: ['profile', 'pluginId', 'enabled'],
        },
        handler: async (args) => {
          const profile = String(args.profile)
          const pluginId = String(args.pluginId)
          const enabled = String(args.enabled) === 'true'
          const ok = enabled ? this.patch.enablePlugin(profile, pluginId) : this.patch.disablePlugin(profile, pluginId)
          this.memory.recordPattern({
            profile,
            type: 'patch',
            action: enabled ? 'enable' : 'disable',
            details: { pluginId, enabled },
            summary: `将插件 ${pluginId} 状态设置为 ${enabled ? '启用' : '禁用'}`,
          })
          this.ctx.emit('godsh/plugin-toggled', { profile, pluginId, enabled })
          return { ok, profile, pluginId, enabled }
        },
      },
      {
        name: 'godsh_snapshot_backup',
        description: '为环境创建全量安全快照或恢复历史快照',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'restore'], description: '操作类型' },
            profile: { type: 'string', description: '环境名称' },
            tagOrId: { type: 'string', description: '快照标签（创建时）或快照 ID（恢复时）' },
          },
          required: ['action', 'profile'],
        },
        handler: async (args) => {
          const action = String(args.action)
          const profile = String(args.profile)
          const tagOrId = args.tagOrId ? String(args.tagOrId) : undefined

          if (action === 'create') {
            const snap = this.backup.createSnapshot(profile, tagOrId)
            return { ok: true, snapshot: snap }
          }
          if (action === 'list') {
            const list = this.backup.listSnapshots(profile)
            return { ok: true, snapshots: list }
          }
          if (action === 'restore') {
            if (!tagOrId) throw new Error('恢复快照需要提供 tagOrId (snapshotId)')
            const ok = this.backup.restoreSnapshot(profile, tagOrId)
            return { ok, restoredId: tagOrId }
          }
          throw new Error(`未知操作: ${action}`)
        },
      },
    ]

    for (const tool of tools) {
      this.ctx.emit('agent:register-tool', tool)
    }
    return tools
  }

  public rpc = {
    getProfiles: () => scanProfiles(this.opts.profilesDir),
    togglePlugin: (profile: string, pluginId: string, enabled: boolean) => {
      return enabled ? this.patch.enablePlugin(profile, pluginId) : this.patch.disablePlugin(profile, pluginId)
    },
    createSnapshot: (profile: string, tag?: string) => this.backup.createSnapshot(profile, tag),
    listSnapshots: (profile: string) => this.backup.listSnapshots(profile),
    restoreSnapshot: (profile: string, id: string) => this.backup.restoreSnapshot(profile, id),
    getMemoryPatterns: (profile?: string) => this.memory.getAllPatterns(profile),
  }

  /**
   * 2. 供 In-DSH UI 调用的 RPC 端点
   */
  public setupRpcEndpoints() {
    // RPC 方法已直接作为实例属性公开在 ctx.godsh 上
  }

  /**
   * 3. 监听 DSH 事件生命周期进行记忆注入
   */
  private hookLifecycleEvents() {
    this.ctx.on('assemble', (event: any) => {
      if (event && event.profile) {
        const injected = this.memory.buildContextInjection(event.profile)
        if (injected && event.systemPrompt) {
          event.systemPrompt += injected
        }
      }
    })
  }
}
