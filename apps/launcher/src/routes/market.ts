import { scanLocalPlugins } from '@godsh/plugin-registry'
import type { ApiHandler } from './types.js'

/** /api/plugins、/api/market —— 本地插件清单 + 市场浏览（带 5 分钟缓存） */
export const marketHandler: ApiHandler = async (ctx, _req, res, method, seg, _body, url) => {
  // GET /api/plugins
  if (seg.length === 1 && seg[0] === 'plugins' && method === 'GET') {
    ctx.sendJson(res, 200, { plugins: scanLocalPlugins(ctx.pluginsDir) })
    return true
  }

  // GET /api/market
  if (seg.length === 1 && seg[0] === 'market' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const plugins = await ctx.getMarket()
    const filtered = q ? plugins.filter((p) => JSON.stringify(p).toLowerCase().includes(q)) : plugins
    ctx.sendJson(res, 200, { plugins: filtered })
    return true
  }

  return false
}
