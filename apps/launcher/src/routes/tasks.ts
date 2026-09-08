import type { ApiHandler } from './types.js'

/**
 * /api/tasks* —— 全局系统任务中心（统一观测与日志监控）
 */
export const tasksHandler: ApiHandler = async (ctx, _req, res, method, seg, _body, url) => {
  const { installTasks } = ctx

  // GET /api/tasks —— 获取全局所有任务列表
  if (seg.length === 1 && seg[0] === 'tasks' && method === 'GET') {
    const list = [...installTasks.entries()].map(([key, rec]) => {
      let type = 'system'
      if (key.startsWith('repair-')) type = 'repair'
      else if (key.startsWith('vault-update-')) type = 'vault'
      else if (key.startsWith('update-all-')) type = 'plugin-update'
      else if (key.startsWith('workflow-')) type = 'workflow'
      else if (key.includes('install')) type = 'install'

      return {
        key,
        type,
        status: rec.status,
        message: rec.message || null,
        logFile: rec.logFile,
      }
    })
    ctx.sendJson(res, 200, { tasks: list, count: list.length })
    return true
  }

  // GET /api/tasks/:key —— 查询单个任务的详细进度与日志片段
  if (seg.length === 2 && seg[0] === 'tasks' && method === 'GET') {
    const key = decodeURIComponent(seg[1] ?? '')
    const view = ctx.installTaskView(key)
    if (!view) {
      ctx.sendJson(res, 404, { error: '任务不存在或已被清理' })
      return true
    }
    ctx.sendJson(res, 200, { key, ...view })
    return true
  }

  // POST /api/tasks/clear —— 清理所有已完成或出错的历史任务
  if (seg.length === 2 && seg[0] === 'tasks' && seg[1] === 'clear' && method === 'POST') {
    let cleared = 0
    for (const [k, rec] of installTasks.entries()) {
      if (rec.status !== 'running') {
        installTasks.delete(k)
        cleared++
      }
    }
    ctx.sendJson(res, 200, { ok: true, cleared })
    return true
  }

  return false
}
