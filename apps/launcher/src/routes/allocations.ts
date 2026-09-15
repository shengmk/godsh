import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOfficialPackage, KNOWN_OFFICIAL_BUNDLES, type OfficialRole } from '@godsh/core'
import { scanProfiles } from '@godsh/profile-manager'
import { pluginAction, resolveInstallArg } from '@godsh/marketplace'
import type { ApiHandler } from './types.js'

/**
 * 官方资产的**只读视图**（服务端构造，前端只渲染）。
 *
 * `version` 必须是该 Profile 的 `node_modules/<pkg>/package.json` 里**实际装到**的版本；
 * 读不到就是 `null`（界面显示「未知」），**绝不回退成市场最新版本号或任何猜测值**。
 */
interface OfficialAssetView {
  name: string
  role: OfficialRole
  version: string | null
}

/**
 * 可分配插件条目。
 *
 * 注意：这里**不含**官方 bundle —— 官方资产在 available 负载里被 {@link isOfficialPackage} 过滤掉
 * （官方资产退出「可分配」面，只经 `officialAssets` 只读展示）。
 */
interface AvailableItemView {
  pluginId: string
  source: 'dependency' | 'bundle'
  allocated: boolean
  enabled: boolean
  description?: string
  version?: string
  category?: string
}

/**
 * 给分配记录负载加上「是否官方资产」分类字段。
 *
 * 「官方」这一事实在本仓库只有一处判定实现（`@godsh/core` 的 `isOfficialPackage`）；
 * 这里只是把结果**随负载下发**，让前端零判定代码地消费它。
 */
function tagOfficial<T extends { pluginId: string }>(a: T): T & { isOfficial: boolean } {
  return { ...a, isOfficial: isOfficialPackage(a.pluginId) }
}

/** /api/allocations* —— 分配 CRUD / 排序 / 移动 / 可分配清单（含 patch 写回守护与回滚） */
export const allocationsHandler: ApiHandler = async (ctx, _req, res, method, seg, body, _url) => {
  const { profilesDir, allocations } = ctx

  // GET /api/allocations
  if (seg.length === 1 && seg[0] === 'allocations' && method === 'GET') {
    ctx.sendJson(res, 200, { allocations: allocations.list().map(tagOfficial) })
    return true
  }

  // POST /api/allocations
  if (seg.length === 1 && seg[0] === 'allocations' && method === 'POST') {
    const profile = body.profile as string
    const pluginId = body.pluginId as string
    const pluginName = (body.pluginName as string) ?? pluginId
    if (!profile || !pluginId) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile, pluginId }' })
      return true
    }
    // 官方资产退出「可分配」面：godsh 不纳管官方 bundle（它们由 dsh 的 dsh.profile.bundles 机制加载），
    // 因此拒绝为其新建分配记录。判据走唯一事实源 `@godsh/core` 的 isOfficialPackage。
    // 注：历史遗留的官方分配记录不受影响 —— 它们仍由 GET /api/allocations 如实返回（只读徽标呈现）。
    if (isOfficialPackage(pluginId)) {
      ctx.sendJson(res, 400, { error: `官方资产由 dsh 维护，godsh 不纳管，不能分配: ${pluginId}` })
      return true
    }
    // 幂等：同一 Profile 已分配该插件时返回既有记录（created=false，不重复创建）
    const before = allocations.list().find((x) => x.profile === profile && x.pluginId === pluginId)
    const a = allocations.allocate(profile, pluginId, pluginName)
    if (body.enabled === false) allocations.setEnabled(a.id, false)
    // 自动写回 patch；写回失败（如 patch 含无法解析的结构）时回滚本次新建并报错，
    // 保证「分配记录」与「实际生效」一致；已存在的幂等分配不删除（那会误删用户原有条目）。
    const apply = ctx.tryApplyAllocation(profile)
    if (!apply.applied) {
      if (!before) allocations.remove(a.id)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败', allocation: before ? tagOfficial(a) : undefined })
      return true
    }
    ctx.sendJson(res, 201, { allocation: tagOfficial(a), created: !before, ...apply })
    return true
  }

  // POST /api/allocations/apply  { profile }
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'apply' && method === 'POST') {
    const profile = body.profile as string
    if (!profile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile }' })
      return true
    }
    const path = allocations.applyProfile(profilesDir, profile)
    ctx.sendJson(res, 200, { ok: true, path })
    return true
  }

  // POST /api/allocations/reorder  { profile, orderedIds }
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'reorder' && method === 'POST') {
    const profile = body.profile as string
    const orderedIds = body.orderedIds as string[]
    if (!profile || !Array.isArray(orderedIds)) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile, orderedIds: string[] }' })
      return true
    }
    const before = allocations.listByProfile(profile).map((a) => a.id)
    allocations.reorder(profile, orderedIds)
    const apply = ctx.tryApplyAllocation(profile)
    if (!apply.applied) {
      allocations.reorder(profile, before)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { allocations: allocations.listByProfile(profile).map(tagOfficial), ...apply })
    return true
  }

  // PATCH /api/allocations/:id  { enabled }
  if (seg.length === 2 && seg[0] === 'allocations' && method === 'PATCH') {
    const id = decodeURIComponent(seg[1] ?? '')
    const prevEnabled = allocations.list().find((x) => x.id === id)?.enabled
    const a = allocations.setEnabled(id, body.enabled !== false)
    const apply = ctx.tryApplyAllocation(a.profile)
    if (!apply.applied) {
      if (prevEnabled !== undefined) allocations.setEnabled(id, prevEnabled)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { allocation: tagOfficial(a), ...apply })
    return true
  }

  // DELETE /api/allocations/:id
  if (seg.length === 2 && seg[0] === 'allocations' && method === 'DELETE') {
    const id = decodeURIComponent(seg[1] ?? '')
    const target = allocations.list().find((x) => x.id === id)
    allocations.remove(id)
    const apply = target ? ctx.tryApplyAllocation(target.profile, [target.pluginId]) : { applied: false }
    if (target && !apply.applied) {
      const restored = allocations.allocate(target.profile, target.pluginId, target.pluginName)
      if (!target.enabled) allocations.setEnabled(restored.id, false)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { ok: true, ...apply })
    return true
  }

  // GET /api/allocations/available —— 每个 Profile 的「可分配插件」清单（含描述）
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'available' && method === 'GET') {    const all = allocations.list()
    // 插件描述/分类：优先市场索引（name/npm 匹配），回退读 profile node_modules 的 package.json
    let marketMap = new Map<string, { desc?: string; version?: string; category?: string }>()
    try {
      const plugins = (await ctx.getMarket()) as Array<{ name?: string; npm?: string; description?: unknown; version?: string; category?: string }>
      for (const p of plugins) {
        if (!p) continue
        const desc = typeof p.description === 'string' ? p.description : (p.description as { zh?: string; en?: string } | undefined)?.zh ?? (p.description as { en?: string } | undefined)?.en
        const category = typeof p.category === 'string' && p.category ? p.category : undefined
        const info = { desc: desc || undefined, version: p.version, category }
        if (p.npm) marketMap.set(p.npm, info)
        if (p.name) marketMap.set(p.name, info)
      }
    } catch {
      /* 市场不可用则只用本地描述 */
    }
    const readPkgDesc = (profileDir: string, pluginId: string): { desc?: string; version?: string } => {
      try {
        const pkgPath = join(profileDir, 'node_modules', ...pluginId.split('/'), 'package.json')
        const pj = JSON.parse(readFileSync(pkgPath, 'utf8')) as { description?: string; version?: string }
        return { desc: pj.description, version: pj.version }
      } catch {
        return {}
      }
    }
    const available: Record<string, AvailableItemView[]> = {}
    // 官方资产的只读视图（含本环境实际装到的版本）：与 available 用同一份 scanProfiles 结果构造，键集一致
    const officialAssets: Record<string, OfficialAssetView[]> = {}
    for (const p of scanProfiles(profilesDir)) {
      const byId = new Map(all.filter((a) => a.profile === p.name).map((a) => [a.pluginId, a]))
      const seen = new Set<string>()
      const items: AvailableItemView[] = []
      const add = (pluginId: string, source: 'dependency' | 'bundle') => {
        if (!pluginId || seen.has(pluginId)) return
        // 官方资产退出「可分配」列表：godsh 不纳管官方 bundle，它们在本环境里只由下方
        // officialAssets（只读视图，见 OfficialAssetView）如实展示，不给任何分配入口。
        if (isOfficialPackage(pluginId)) return
        seen.add(pluginId)
        const a = byId.get(pluginId)
        const m = marketMap.get(pluginId)
        const local = readPkgDesc(p.dir, pluginId)
        items.push({
          pluginId,
          source,
          allocated: Boolean(a),
          enabled: a ? a.enabled : false,
          description: m?.desc || local.desc || undefined,
          version: m?.version || local.version || undefined,
          category: m?.category,
        })
      }
      for (const dep of Object.keys(p.dependencies ?? {})) add(dep, 'dependency')
      for (const b of p.bundles ?? []) add(b, 'bundle')
      available[p.name] = items
      // 版本只认 node_modules 里的实装版本（不经市场索引），读不到即 null → 前端显示「未知」
      officialAssets[p.name] = KNOWN_OFFICIAL_BUNDLES.map((asset) => ({
        name: asset.name,
        role: asset.role,
        version: readPkgDesc(p.dir, asset.name).version ?? null,
      }))
    }
    ctx.sendJson(res, 200, { available, officialAssets })
    return true
  }

  // POST /api/allocations/assign-category  { profile, category }
  // 「按分类自动分配」：把该环境已安装（dependencies ∪ bundles）且属于该市场分类的插件全部分配（写回 patch）。
  // 只做分配，不做安装 —— 插件须已在该环境安装。返回新增分配数 / 已分配跳过数。
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'assign-category' && method === 'POST') {
    const profile = body.profile as string
    const category = body.category as string
    if (!profile || !category) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile, category }' })
      return true
    }
    // 市场 name/npm → category 映射（含带 # 后缀的展示名去后缀匹配）
    const catByName = new Map<string, string>()
    try {
      const plugins = (await ctx.getMarket()) as Array<{ name?: string; npm?: string; category?: string }>
      for (const p of plugins) {
        if (!p || typeof p.category !== 'string' || !p.category) continue
        if (typeof p.name === 'string' && p.name) catByName.set(p.name, p.category)
        if (typeof p.npm === 'string' && p.npm) catByName.set(p.npm, p.category)
      }
    } catch {
      /* 市场不可用时按插件名直接匹配（分类映射缺失则无法归类，返回空结果） */
    }
    const profileData = scanProfiles(profilesDir).find((x) => x.name === profile)
    if (!profileData) {
      ctx.sendJson(res, 404, { error: `环境不存在: ${profile}` })
      return true
    }
    // 该环境已安装的插件 id 列表（bundle + dependency），去重保序
    const installedIds = [...new Set([...(profileData.bundles ?? []), ...Object.keys(profileData.dependencies ?? {})])]
    // 分类匹配：优先精确 name/npm；name 含 # 时去掉 # 后缀再试
    const belongs = (id: string): boolean => {
      const c = catByName.get(id) ?? catByName.get(id.split('#')[0]!)
      return c === category
    }
    // 官方资产退出「可分配」面：分类一键分配同样是「新增分配」，不得把官方 bundle 纳进来
    // （available 列表已过滤它们，这里按同一条判据保持一致，避免绕过前端直接调 API 时漏掉）
    const matched = installedIds.filter((id) => belongs(id) && !isOfficialPackage(id))
    const existing = new Set(allocations.list().filter((a) => a.profile === profile).map((a) => a.pluginId))
    const toAssign = matched.filter((id) => !existing.has(id))
    let assigned = 0
    for (const id of toAssign) {
      allocations.allocate(profile, id, id)
      assigned++
    }
    const apply = ctx.tryApplyAllocation(profile)
    if (!apply.applied) {
      // 写回失败：回滚本次新增
      for (const id of toAssign) {
        const rec = allocations.list().find((a) => a.profile === profile && a.pluginId === id)
        if (rec) allocations.remove(rec.id)
      }
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, {
      profile,
      category,
      matched: matched.length,
      assigned,
      skipped: matched.length - assigned,
      allocated: matched.filter((id) => existing.has(id) || toAssign.includes(id)).length,
      ...apply,
    })
    return true
  }

  // POST /api/allocations/move-with-install  { pluginId, fromProfile?, toProfile, marketName? }
  // 「剪切并复制」：把插件转移到目标环境 —— 目标环境未安装时自动安装（dsh plugin add），
  // 再从源环境移除分配（若存在），在目标环境分配。保证目标环境真正能调用。
  if (seg.length === 2 && seg[0] === 'allocations' && seg[1] === 'move-with-install' && method === 'POST') {
    const pluginId = body.pluginId as string
    const toProfile = body.toProfile as string
    const fromProfile = body.fromProfile as string | undefined
    if (!pluginId || !toProfile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { pluginId, toProfile }' })
      return true
    }
    const profiles = scanProfiles(profilesDir)
    const target = profiles.find((p) => p.name === toProfile)
    if (!target) {
      ctx.sendJson(res, 404, { error: `目标环境不存在: ${toProfile}` })
      return true
    }
    // 1) 目标环境是否已安装（dependencies ∪ bundles）
    const targetInstalled = [...(target.bundles ?? []), ...Object.keys(target.dependencies ?? {})]
    let marketPlugin: { name?: string; npm?: string; install?: string } | undefined
    if (typeof body.marketName === 'string' && body.marketName) {
      const plugins = (await ctx.getMarket()) as Array<{ name?: string; npm?: string; install?: string }>
      marketPlugin = plugins.find((p) => p?.name === body.marketName)
    }
    const installArg = resolveInstallArg(marketPlugin ?? { name: pluginId, install: undefined, npm: pluginId })
    // 2) 未安装则自动安装到目标环境
    if (!targetInstalled.includes(pluginId) && !targetInstalled.includes(installArg ?? '')) {
      const r = await pluginAction(toProfile, 'add', installArg ?? pluginId)
      if (!r.ok) {
        ctx.sendJson(res, 400, {
          ok: false,
          error: `自动安装到 ${toProfile} 失败（${r.stdout || r.stderr}），请到插件市场检查该插件`,
          stdout: r.stdout,
          stderr: r.stderr,
        })
        return true
      }
    }
    // 3) 从源环境移除分配（若存在）
    if (fromProfile) {
      const existing = allocations.list().find((x) => x.profile === fromProfile && x.pluginId === pluginId)
      if (existing) {
        allocations.remove(existing.id)
        ctx.tryApplyAllocation(fromProfile, [pluginId])
      }
    }
    // 4) 目标环境分配（幂等）
    const a = allocations.allocate(toProfile, pluginId, pluginId)
    const apply = ctx.tryApplyAllocation(toProfile)
    if (!apply.applied) {
      allocations.remove(a.id)
      ctx.sendJson(res, 409, { error: apply.applyError ?? '写回 cordis.patch.yml 失败' })
      return true
    }
    ctx.sendJson(res, 200, { ok: true, allocation: tagOfficial(a), installed: targetInstalled.includes(pluginId) || targetInstalled.includes(installArg ?? '') })
    return true
  }

  // POST /api/allocations/:id/move  { profile }
  if (seg.length === 3 && seg[0] === 'allocations' && seg[2] === 'move' && method === 'POST') {
    const id = decodeURIComponent(seg[1] ?? '')
    const toProfile = body.profile as string
    if (!toProfile) {
      ctx.sendJson(res, 400, { error: 'body 需要 { profile }' })
      return true
    }
    const target = allocations.list().find((x) => x.id === id)
    if (!target) {
      ctx.sendJson(res, 404, { error: `分配关系不存在: ${id}` })
      return true
    }
    if (target.profile === toProfile) {
      ctx.sendJson(res, 400, { error: '目标 Profile 与当前相同' })
      return true
    }
    const fromProfile = target.profile
    allocations.remove(id)
    const moved = allocations.allocate(toProfile, target.pluginId, target.pluginName)
    if (!target.enabled) allocations.setEnabled(moved.id, false)
    const oldApply = ctx.tryApplyAllocation(fromProfile, [target.pluginId])
    const newApply = ctx.tryApplyAllocation(toProfile)
    ctx.sendJson(res, 200, { allocation: tagOfficial(moved), fromProfile, ...oldApply, newApply })
    return true
  }

  return false
}
