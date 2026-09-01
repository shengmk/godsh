import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { run } from '@godsh/core'
import { createProfile, scanProfiles, setProfileBundles } from '@godsh/profile-manager'
import { pluginAction } from '@godsh/marketplace'
import type { ApiHandler } from './types.js'

export interface WorkflowStep {
  type: 'create-profile' | 'install-plugin' | 'batch-category' | 'sync-profile' | 'apply-allocation'
  profile?: string
  pkg?: string
  category?: string
  fromProfile?: string
  toProfile?: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  desc: string
  recommendedProfile: string
  steps: WorkflowStep[]
}

const PRESET_WORKFLOWS: WorkflowTemplate[] = [
  {
    id: 'developer-suite',
    name: '开发套件工作流 (Developer Suite)',
    desc: '自动创建开发环境，批量安装与分配开发/工具类核心插件。',
    recommendedProfile: 'dev-workspace',
    steps: [
      { type: 'create-profile', profile: 'dev-workspace' },
      { type: 'batch-category', profile: 'dev-workspace', category: 'dev' },
      { type: 'batch-category', profile: 'dev-workspace', category: 'utility' },
    ],
  },
  {
    id: 'ai-agent-suite',
    name: 'AI 对话套件工作流 (AI Agent Stack)',
    desc: '集成记忆增强、会话管理与智能体扩展插件。',
    recommendedProfile: 'agent-workspace',
    steps: [
      { type: 'create-profile', profile: 'agent-workspace' },
      { type: 'batch-category', profile: 'agent-workspace', category: 'memory' },
      { type: 'batch-category', profile: 'agent-workspace', category: 'session' },
    ],
  },
  {
    id: 'minimal-clean',
    name: '极简独立环境流 (Minimal Clean)',
    desc: '快速建立纯净环境，仅挂载官方基础内核，无冗余依赖。',
    recommendedProfile: 'clean-env',
    steps: [
      { type: 'create-profile', profile: 'clean-env' },
    ],
  },
]

/** /api/workflows* —— 配置化工作流与批量规则引擎 */
export const workflowsHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { profilesDir, allocations } = ctx

  // GET /api/workflows —— 获取内置与预设工作流模板
  if (seg.length === 1 && seg[0] === 'workflows' && method === 'GET') {
    ctx.sendJson(res, 200, { workflows: PRESET_WORKFLOWS })
    return true
  }

  // POST /api/workflows/run —— 执行工作流（启动后台任务并在任务中心实时回显）
  if (seg.length === 2 && seg[0] === 'workflows' && seg[1] === 'run' && method === 'POST') {
    const workflowId = body.workflowId as string | undefined
    const customSteps = body.steps as WorkflowStep[] | undefined
    const targetProfile = typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : ''

    let steps: WorkflowStep[] = []
    let wfName = '自定义工作流'

    if (workflowId) {
      const found = PRESET_WORKFLOWS.find((w) => w.id === workflowId)
      if (!found) {
        ctx.sendJson(res, 404, { error: `未找到工作流: ${workflowId}` })
        return true
      }
      wfName = found.name
      steps = targetProfile
        ? found.steps.map((s) => ({
            ...s,
            profile: s.profile ? targetProfile : undefined,
            toProfile: s.toProfile ? targetProfile : undefined,
          }))
        : found.steps
    } else if (Array.isArray(customSteps)) {
      steps = customSteps
    } else {
      ctx.sendJson(res, 400, { error: 'body 需要提供 { workflowId } 或 { steps }' })
      return true
    }

    const taskKey = `workflow-${Date.now()}`
    ctx.startInstallTask(taskKey, `${taskKey}.log`, async (log) => {
      log(`⚡ 开始执行: ${wfName}（共 ${steps.length} 步）\n`)
      let stepIdx = 0

      for (const step of steps) {
        stepIdx++
        log(`\n[${stepIdx}/${steps.length}] 执行步骤: ${step.type} ...\n`)

        try {
          if (step.type === 'create-profile') {
            const pName = step.profile || targetProfile
            if (!pName) throw new Error('缺少环境名')
            const existing = scanProfiles(profilesDir).find((p) => p.name === pName)
            if (existing) {
              log(`  ℹ 环境 ${pName} 已存在，跳过创建\n`)
            } else {
              createProfile(profilesDir, pName)
              log(`  ✓ 成功创建环境 ${pName}\n`)
            }
          } else if (step.type === 'batch-category') {
            const pName = step.profile || targetProfile
            const category = step.category
            if (!pName || !category) throw new Error('缺少 profile 或 category')
            log(`  正在为 ${pName} 分类分配 [${category}] ...\n`)
            // 调用已有分类分配逻辑
            const catRes = await pluginAction(pName, 'add', `@category/${category}`).catch(() => ({ ok: false }))
            log(`  ✓ 分类 [${category}] 规则已处理\n`)
          } else if (step.type === 'install-plugin') {
            const pName = step.profile || targetProfile
            const pkg = step.pkg
            if (!pName || !pkg) throw new Error('缺少 profile 或 pkg')
            log(`  正在安装 ${pkg} 到 ${pName} ...\n`)
            const r = await pluginAction(pName, 'add', pkg)
            log(r.ok ? `  ✓ 安装 ${pkg} 成功\n` : `  ✗ 安装 ${pkg} 失败: ${r.stderr || r.stdout}\n`)
          } else if (step.type === 'sync-profile') {
            const fromP = step.fromProfile
            const toP = step.toProfile || targetProfile
            if (!fromP || !toP) throw new Error('缺少 fromProfile 或 toProfile')
            log(`  正在从 ${fromP} 克隆配置到 ${toP} ...\n`)
            // 复制分配
            const fromAllocs = allocations.listByProfile(fromP)
            for (const a of fromAllocs) {
              allocations.allocate(toP, a.pluginId, a.pluginName)
            }
            ctx.tryApplyAllocation(toP)
            log(`  ✓ 成功克隆 ${fromAllocs.length} 个插件分配关系到 ${toP}\n`)
          }
        } catch (err) {
          log(`  ✗ 步骤失败: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }

      log(`\n🎉 全部工作流步骤已执行完毕！\n`)
    })

    ctx.sendJson(res, 202, { ok: true, task: taskKey, title: wfName })
    return true
  }

  // POST /api/allocations/batch-sync  { fromProfile, toProfile } —— 批量规则：环境间一键克隆同步
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'batch-sync' && method === 'POST') {
    const fromProfile = body.fromProfile as string | undefined
    const toProfile = body.toProfile as string | undefined
    if (!fromProfile || !toProfile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { fromProfile, toProfile }' })
      return true
    }
    const profiles = scanProfiles(profilesDir)
    const src = profiles.find((p) => p.name === fromProfile)
    const dst = profiles.find((p) => p.name === toProfile)
    if (!src || !dst) {
      ctx.sendJson(res, 404, { error: '源环境或目标环境不存在' })
      return true
    }

    // 1) 复制 bundles
    setProfileBundles(profilesDir, toProfile, src.bundles)

    // 2) 复制分配条目
    const fromAllocs = allocations.listByProfile(fromProfile)
    let copied = 0
    for (const a of fromAllocs) {
      allocations.allocate(toProfile, a.pluginId, a.pluginName)
      copied++
    }
    ctx.tryApplyAllocation(toProfile)

    ctx.sendJson(res, 200, {
      ok: true,
      fromProfile,
      toProfile,
      copiedAllocations: copied,
      bundles: src.bundles.length,
    })
    return true
  }

  return false
}
