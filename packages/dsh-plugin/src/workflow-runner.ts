import { pluginAction, resolveInstallArg } from '@godsh/marketplace'
import { createProfile, scanProfiles } from '@godsh/profile-manager'
import type { AllocationManager } from '@godsh/allocation'

export interface WorkflowStep {
  type: 'create-profile' | 'install-plugin' | 'batch-category' | 'sync-profile'
  profile?: string
  pkg?: string
  pkgs?: string[]
  category?: string
  limit?: number
  fromProfile?: string
  toProfile?: string
}

export interface WorkflowOptions {
  onLog?: (chunk: string) => void
  getMarket?: () => Promise<unknown[]>
}

export class WorkflowRunner {
  constructor(
    private profilesDir: string,
    private allocations: AllocationManager,
    private applyAllocationFn?: (profile: string) => void
  ) {}

  async executeSteps(steps: WorkflowStep[], targetProfile?: string, opts: WorkflowOptions = {}): Promise<{ ok: boolean; executed: number; errors: string[] }> {
    const log = opts.onLog ?? (() => {})
    let executed = 0
    const errors: string[] = []

    for (const step of steps) {
      executed++
      const pName = step.profile || targetProfile || ''

      try {
        if (step.type === 'create-profile') {
          if (!pName) throw new Error('缺少环境名')
          const existing = scanProfiles(this.profilesDir).find((p) => p.name === pName)
          if (!existing) {
            createProfile(this.profilesDir, pName)
            log(`  ✓ 成功创建环境 ${pName}\n`)
          } else {
            log(`  ℹ 环境 ${pName} 已存在，跳过\n`)
          }
        } else if (step.type === 'batch-category') {
          const category = step.category
          if (!pName || !category) throw new Error('缺少 profile 或 category')
          log(`  正在检索分类 [${category}] 推荐插件...\n`)

          let matched: Array<{ name: string; npm?: string; install?: string; stars?: number; downloads?: number }> = []
          if (opts.getMarket) {
            try {
              const market = (await opts.getMarket()) as Array<{ name?: string; npm?: string; category?: string; install?: string; stars?: number; downloads?: number }>
              matched = market.filter((p) => p && p.category === category && (p.name || p.npm)) as any
            } catch {
              matched = []
            }
          }
          matched.sort((a, b) => ((b.downloads ?? 0) + (b.stars ?? 0) * 10) - ((a.downloads ?? 0) + (a.stars ?? 0) * 10))
          const limit = step.limit ?? 1
          const picked = matched.slice(0, limit)

          if (picked.length > 0) {
            const installArgs = picked.map((p) => resolveInstallArg(p)).filter(Boolean) as string[]
            log(`  ✓ 匹配推荐插件: ${picked.map((p) => p.name).join(', ')}\n`)
            log(`  正在批量安装到 ${pName} ...\n`)
            const r = await pluginAction(pName, 'add', installArgs, { onLog: log })
            if (r.ok) {
              log(`  ✓ 批量安装完成\n`)
              for (const p of picked) {
                const id = p.npm || p.name.split('#')[0]!
                this.allocations.allocate(pName, id, p.name)
              }
              this.applyAllocationFn?.(pName)
            } else {
              log(`  ✗ 批量安装未完全成功: ${r.stderr || r.stdout}\n`)
            }
          } else {
            log(`  ℹ 分类 [${category}] 暂无匹配插件，跳过\n`)
          }
        } else if (step.type === 'install-plugin') {
          const pkg = step.pkg || (step.pkgs && step.pkgs[0])
          if (!pName || !pkg) throw new Error('缺少 profile 或 pkg')
          const pkgList = Array.isArray(step.pkgs) && step.pkgs.length > 0 ? step.pkgs : [pkg]
          log(`  正在安装 ${pkgList.join(', ')} ...\n`)
          const r = await pluginAction(pName, 'add', pkgList, { onLog: log })
          if (r.ok) {
            for (const k of pkgList) {
              this.allocations.allocate(pName, k, k)
            }
            this.applyAllocationFn?.(pName)
            log(`  ✓ 安装与规则生效完成\n`)
          } else {
            log(`  ✗ 安装失败: ${r.stderr || r.stdout}\n`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(msg)
        log(`  ✗ 步骤失败: ${msg}\n`)
      }
    }
    return { ok: errors.length === 0, executed, errors }
  }
}
