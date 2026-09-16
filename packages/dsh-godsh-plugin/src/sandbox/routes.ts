/**
 * 沙箱页的 HTTP 面：`/api/dsh-godsh/sandbox/*`（方案分部 G）。
 *
 * 与自检端点（`/api/dsh-godsh/ping|probe|entries|…`）的分工：
 *   - 自检端点回答"热装载桥通不通"；
 *   - 本文件回答"沙箱里有什么、把某个插件注入到某个环境、移除、回收、收割"。
 *
 * 两条纪律
 * -------
 *  1. **鉴权与兜底复用 `guarded()`**：这些端点能在运行树里挂东西，安全性必须与自检端点
 *     完全一致 —— 两处各写一遍必然漂移。
 *  2. **写操作返回四阶段结论，而不是一个布尔**：界面要能如实告诉用户"已生效 / 需启动该环境 /
 *     已挂载但未声明 / 失败"，含糊的 `ok:true` 正是本项目反复在打的那类缺陷。
 *
 * @module @godsh/dsh/sandbox/routes
 */

import type { SandboxService } from './service.js'
import { GODSH_API_PREFIX, guarded, readJsonBody, sendJson, str } from '../routes.js'
import type { WebRoute } from '../host-types.js'

/** 沙箱路由前缀（浏览器半必须用同一个）。 */
export const SANDBOX_API_PREFIX = `${GODSH_API_PREFIX}/sandbox`

/** 从请求体里取字符串数组（元素必须是字符串；非法项丢弃并计数）。 */
function strArray(value: unknown): { ids: string[]; dropped: number } {
  if (!Array.isArray(value)) return { ids: [], dropped: 0 }
  const ids: string[] = []
  let dropped = 0
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') ids.push(item)
    else dropped++
  }
  return { ids, dropped }
}

/**
 * 构造沙箱路由。
 *
 * @param sandbox - 沙箱服务实例。
 * @returns 待注册的 `WebRoute` 列表。
 */
export function buildSandboxRoutes(sandbox: SandboxService): WebRoute[] {
  /** 只接受 POST 的写端点统一前置检查。 */
  const requirePost = (req: { method?: string }, res: Parameters<typeof sendJson>[0]): boolean => {
    if (req.method === 'POST') return true
    sendJson(res, 405, { ok: false, error: '需要 POST' })
    return false
  }

  return [
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/status`,
      handler: guarded((_req, res) => {
        sendJson(res, 200, { ok: true, status: sandbox.status() })
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/list`,
      handler: guarded((_req, res) => {
        const entries = sandbox.list()
        sendJson(res, 200, { ok: true, count: entries.length, entries, status: sandbox.status() })
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/history`,
      handler: guarded((_req, res) => {
        sendJson(res, 200, { ok: true, snapshots: sandbox.history() })
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/metrics`,
      handler: guarded((_req, res) => {
        sendJson(res, 200, { ok: true, metrics: sandbox.metrics() })
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/check-updates`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        sendJson(res, 200, await sandbox.checkUpdates())
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/inject`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const pluginId = str(body.pluginId)
        if (pluginId === null) return sendJson(res, 400, { ok: false, error: '缺少 pluginId（沙箱条目 id 或包名）' })
        const profile = str(body.profile)
        const version = str(body.version)
        const result = await sandbox.inject(
          pluginId,
          profile ?? undefined,
          version ?? undefined,
        )
        // 生效范围决定状态码：live/needs-profile-start 都是"注入成功"（只是生效时机不同），
        // registered-only 是"半成品"，failed 是失败 —— 让调用方能凭状态码分流。
        const status = result.effectiveness === 'failed' ? 409 : result.effectiveness === 'registered-only' ? 202 : 200
        sendJson(res, status, result)
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/remove`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const { ids, dropped } = strArray(body.ids)
        if (ids.length === 0) return sendJson(res, 400, { ok: false, error: '缺少 ids（要移除的沙箱条目 id 数组）' })
        const result = await sandbox.remove(ids)
        sendJson(res, result.ok ? 200 : 409, { ...result, requested: ids.length, dropped })
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/update`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const id = str(body.id)
        if (id === null) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const version = str(body.version)
        const result = await sandbox.updatePlugin(id, version ?? undefined)
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/gc`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        const result = await sandbox.garbageCollect()
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
    {
      kind: 'exact',
      path: `${SANDBOX_API_PREFIX}/harvest`,
      handler: guarded(async (req, res) => {
        if (!requirePost(req, res)) return
        const result = await sandbox.harvest()
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
  ]
}
