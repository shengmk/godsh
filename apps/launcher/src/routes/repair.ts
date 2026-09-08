import { RepairAgent } from '@godsh/core'
import { DshBackupManager } from '@godsh/dsh-plugin'
import type { ApiHandler } from './types.js'

/**
 * /api/repair* —— 7 阶段自动化环境自愈与灾难修复工作流引擎
 */
export const repairHandler: ApiHandler = async (ctx, _req, res, method, seg, body, url) => {
  const { profilesDir, env } = ctx
  const backupManager = new DshBackupManager(profilesDir)

  // POST /api/repair/workflow { profile, targetSnapshotId? } —— 触发 7 阶段自愈工作流
  if (seg.length === 2 && seg[0] === 'repair' && seg[1] === 'workflow' && method === 'POST') {
    const { profile, targetSnapshotId } = body as { profile?: string; targetSnapshotId?: string }
    if (!profile) {
      ctx.sendJson(res, 400, { error: '缺少 profile 参数' })
      return true
    }

    const taskKey = `repair-${profile}-${Date.now()}`
    const logName = `repair-${profile}-${Date.now()}.log`

    ctx.startInstallTask(taskKey, logName, async (log) => {
      const agent = new RepairAgent({
        dshHome: env.dshHome,
        profilesDir,
        targetSnapshotId,
        restoreFromSnapshot: (p, s) => backupManager.restoreSnapshot(p, s),
        createIncidentSnapshot: (p, desc) =>
          backupManager.createSnapshot(p, {
            description: desc,
            trigger: 'repair-workflow',
          }).id,
        onLog: (msg) => log(msg),
      })

      const report = await agent.run(profile)
      if (!report.success) {
        throw new Error(report.error || '自愈工作流执行失败')
      }
    })

    ctx.sendJson(res, 202, {
      ok: true,
      task: taskKey,
      profile,
      message: '已启动 7 阶段自动化自愈工作流',
    })
    return true
  }

  // GET /api/repair/task-progress?task=<taskKey> —— 轮询自愈工作流进度与实时日志
  if (seg.length === 2 && seg[0] === 'repair' && seg[1] === 'task-progress' && method === 'GET') {
    const task = String(url.searchParams.get('task') ?? '')
    const view = task ? ctx.installTaskView(task) : null
    if (!view) {
      ctx.sendJson(res, 404, { error: '自愈任务不存在或已过期' })
      return true
    }
    ctx.sendJson(res, 200, view)
    return true
  }

  return false
}
