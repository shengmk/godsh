import { scanLocalPlugins } from '@godsh/plugin-registry'
import type { ApiHandler } from './types.js'

/** 市场分类 → 中文名（dshmarket 官方分类）。 */
export const CATEGORY_ZH: Record<string, string> = {
  agi: 'AGI 智能',
  ui: 'UI 界面',
  usage: '用量统计',
  theme: '主题皮肤',
  model: '模型',
  identity: '身份',
  session: '会话',
  memory: '记忆',
  tools: '工具',
  browser: '浏览器',
  vision: '视觉',
  voice: '语音',
  docs: '文档',
  skill: '技能',
  workflow: '工作流',
  git: 'Git',
  notify: '通知',
  dev: '开发',
  security: '安全',
  remote: '远程',
  market: '市场',
  fun: '趣味',
}

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

  // GET /api/market/categories —— 市场分类概览（分类 → 插件数 + 中文名）
  if (seg.length === 2 && seg[0] === 'market' && seg[1] === 'categories' && method === 'GET') {
    try {
      const plugins = (await ctx.getMarket()) as Array<{ name?: string; category?: string }>
      const count = new Map<string, number>()
      for (const p of plugins) {
        const c = typeof p.category === 'string' && p.category.trim() ? p.category : 'other'
        count.set(c, (count.get(c) ?? 0) + 1)
      }
      const categories = [...count.entries()]
        .map(([category, cnt]) => ({ category, count: cnt, zh: CATEGORY_ZH[category] ?? category }))
        .sort((a, b) => b.count - a.count)
      ctx.sendJson(res, 200, { categories })
    } catch (err) {
      ctx.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  return false
}
