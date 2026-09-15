/**
 * `@godsh/dsh` 宿主半的 HTTP 面：`/api/dsh-godsh/*`。
 *
 * 设计纪律
 * --------
 *  1. **回环 + 同源信任围栏**：与 `@linxin666/dsh-ssh` / `dsh-config-manager` 已验证的路由同构 ——
 *     非回环来源一律 403。这些端点能在运行树里装载/卸载插件，属于高权限面，绝不能对局域网开放。
 *  2. **路由只做协议适配**：真正的动作在 `HotBridge` 里；路由负责鉴权、解析、序列化与错误收敛。
 *  3. **错误一律 200 + `ok:false` 或 4xx/5xx 带 `error` 字段**，绝不把异常抛回 dsh 的 webserver
 *     —— 那是把用户整棵树带崩的最短路径。
 *
 * @module @godsh/dsh/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HotBridge } from './hot-bridge.js'
import { describe } from './hot-bridge.js'
import type { WebRoute, WebServerLike } from './host-types.js'

/** 路由前缀。浏览器半必须用同一个前缀（两处写死同一字符串，改一处即断）。 */
export const GODSH_API_PREFIX = '/api/dsh-godsh'

/** 请求体大小上限（这些端点的负载都是小 JSON）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 回环地址判定（IPv4 / IPv6 / IPv4-mapped）。 */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 读取并解析 JSON 请求体；超限或非法返回 `null`。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buf.length
      if (total > MAX_BODY_BYTES) return null
      chunks.push(buf)
    }
  } catch {
    return null
  }
  if (total === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 统一的 JSON 应答。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body).toString(),
  })
  res.end(body)
}

/** 参数取值助手：非空字符串才接受。 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 构造全部路由。
 *
 * @param bridge - 热装载桥实例。
 * @returns 待注册的 `WebRoute` 列表（调用方负责 `webServer.register`）。
 */
export function buildRoutes(bridge: HotBridge): WebRoute[] {
  const guard = (handler: WebRoute['handler']): WebRoute['handler'] => {
    return async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '这些端点仅允许回环访问' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        // 最后一道网：任何未预料的异常都不能穿透回 dsh
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(error) })
        else try { res.end() } catch { /* 响应已断，无能为力 */ }
      }
    }
  }

  return [
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/ping`,
      handler: guard((_req, res) => {
        sendJson(res, 200, { ok: true, plugin: '@godsh/dsh', bridge: bridge.probe().backend })
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/probe`,
      handler: guard((_req, res) => {
        sendJson(res, 200, { ok: true, probe: bridge.probe() })
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/entries`,
      handler: guard((_req, res) => {
        const entries = bridge.list()
        sendJson(res, 200, { ok: true, count: entries.length, entries })
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/log`,
      handler: guard((_req, res) => {
        sendJson(res, 200, { ok: true, lines: bridge.recentLog() })
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/mount`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' })
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const name = str(body.name)
        if (name === null) return sendJson(res, 400, { ok: false, error: '缺少 name（要装载的包名）' })
        const id = str(body.id)
        const result = await bridge.mount(name, id === null ? {} : { id })
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/disable`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' })
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const rowId = str(body.rowId)
        if (rowId === null) return sendJson(res, 400, { ok: false, error: '缺少 rowId（loader 条目 id）' })
        const disabled = body.disabled === true
        const result = await bridge.setDisabled(rowId, disabled)
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
    {
      kind: 'exact',
      path: `${GODSH_API_PREFIX}/unmount`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' })
        const body = await readJsonBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON 对象且不超过 64KB' })
        const name = str(body.name)
        if (name === null) return sendJson(res, 400, { ok: false, error: '缺少 name（要卸载的包名）' })
        const result = await bridge.unmount(name)
        sendJson(res, result.ok ? 200 : 409, result)
      }),
    },
  ]
}

/**
 * 把所有路由注册进 dsh 的 web 服务器，并返回一个卸载器。
 *
 * 注册失败**不抛**：没有 webServer 的 profile（headless/sdk）本来就不该有 HTTP 面，
 * 插件仍应正常装载（宿主能力如热装载桥依然可用，将来可由 agent 工具面消费）。
 *
 * @param webServer - `ctx.get('webServer')` 的结果（`unknown`，内部收窄）。
 * @param routes - {@link buildRoutes} 的产物。
 * @returns 卸载函数；未注册成功时返回一个空的卸载器。
 */
export function registerRoutes(webServer: unknown, routes: WebRoute[]): () => void {
  const disposers: (() => void)[] = []
  try {
    const ws = webServer as WebServerLike
    if (typeof ws?.register !== 'function') return () => {}
    for (const route of routes) {
      const dispose = ws.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch {
    // 已经注册成功的部分保留；失败的静默降级（不阻断插件装载）
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载失败不影响其它路由 */
      }
    }
  }
}
