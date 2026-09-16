/**
 * `SandboxService` —— 把 godsh 的沙箱引擎搬进 dsh 进程（方案分部 G）。
 *
 * 设计立场
 * -------
 * **不重写引擎，只换壳。** 沙箱的全部逻辑（junction 零拷贝挂载、按父隔离的子副本、
 * 组合语义、GC、收割、事务化写入与回滚）已经存在于 `@godsh/plugin-registry` 的
 * `VaultManager` 里，并且是被单测与变异测试压过的那一份。本模块的职责只有三件：
 *
 *   1. **解析出与启动器同一个数据目录**（见 `./data-dir.js`）—— 否则就是"又造了一个沙箱"；
 *   2. **把「注入」补齐成四阶段**（物理 → 声明 → 热装载 → 判定），
 *      其中"声明"复用 `AllocationManager.applyProfile`（与启动器的分配页同一条写补丁层路径），
 *      "热装载"复用 `HotBridge`（在运行树里直接建条目，不重启）；
 *   3. **如实报告生效范围**：目标环境就是本进程时才算"已生效"，
 *      目标环境是别的 profile 时必须说"需在该环境启动后生效"，**不得含糊成"成功"**。
 *
 * 为什么"声明"这一步不能省
 * ----------------------
 * `VaultManager.deployToProfile` 只做物理挂载 + `package.json` 依赖声明 + `bundles` 门控；
 * 它**不写** `<profile>/cordis.patch.yml`（只有 bundle 类插件才会进 `bundles`）。
 * 对普通插件而言，"写进补丁层"才是它生效的声明渠道 —— 这正是启动器分配页在做的事。
 * 所以注入必须把这一步一并做掉，否则用户会看到"注入成功但插件没生效"，然后去找"分配"。
 *
 * 任何对外方法都**不抛异常**：它跑在用户的 dsh 进程里，异常穿出去可能把整棵树带崩。
 *
 * @module @godsh/dsh/sandbox/service
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AllocationManager } from '@godsh/allocation'
import { ConfigStore } from '@godsh/core'
import {
  VaultManager,
  inferVaultOrigin,
  isUpdatableEntry,
  originLabel,
  type DeploymentSnapshot,
  type DiskSavingsReport,
  type VaultPlugin,
} from '@godsh/plugin-registry'
import type { HotBridge, HotResult } from '../hot-bridge.js'
import { hostBaseDir, type HostContext } from '../host-types.js'
import { resolveSandboxDataDir, type DataDirResolution } from './data-dir.js'

/** 沙箱条目的界面视图（已在服务端算好"能不能更新""来源是什么"）。 */
export interface SandboxEntryView {
  id: string
  name: string
  version: string
  kind: string
  /** 父插件 id（存在即表示本条是某父的附属子依赖）。 */
  parentId?: string
  childOrigin?: 'standalone' | 'shared-copy'
  /** 渲染用：子依赖不提供操作入口。 */
  isChild: boolean
  /** 真实来源类别与中文标签。 */
  originKind: string
  originLabel: string
  /** 能否从 npm 自动更新（判据与后端更新器同源）。 */
  updatable: boolean
  hasUpdate: boolean
  latestVersion?: string
  installedProfiles: string[]
  sizeBytes?: number
  securityLevel?: string
}

/** 沙箱整体状态（自检面板与页面头部用）。 */
export interface SandboxStatus {
  dataDir: string
  dataDirFrom: string
  dataDirReason: string
  storeDir: string
  /** vault.json 是否存在（不存在 = 空沙箱，不是错误）。 */
  indexExists: boolean
  /** 本 dsh 进程所在的环境名；拿不到则为 null。 */
  ownProfile: string | null
  profilesDir: string | null
  count: number
  /** 读索引失败时的可读原因（此时其它操作都应视为不可用）。 */
  error?: string
}

/** 注入的四阶段结果。 */
export interface InjectPhases {
  /** ① 目标环境与物理源是否就位（`deployToProfile` 内部前置干跑校验）。 */
  preflight: { ok: boolean; message: string }
  /** ② 物理挂载 + `package.json` 声明 + bundles 门控（含失败回滚）。 */
  physical: { ok: boolean; message: string; deployed: string[]; companions: string[] }
  /** ③ 写补丁层（与启动器分配页同一条路径）。 */
  declared: { ok: boolean; message: string; patchPath?: string }
  /** ④ 热装载进运行树（仅当目标环境就是本进程所在环境）。 */
  hotMounted: { attempted: boolean; ok: boolean; message: string; results: HotResult[] }
}

/** 注入的生效范围 —— 界面必须如实显示这一项，不允许含糊成"成功"。 */
export type InjectEffectiveness = 'live' | 'needs-profile-start' | 'registered-only' | 'failed'

/** 注入结果。 */
export interface InjectResult {
  ok: boolean
  pluginId: string
  profile: string
  effectiveness: InjectEffectiveness
  /** 面向用户的一句话结论。 */
  message: string
  phases: InjectPhases
}

/**
 * 沙箱服务：包住 `VaultManager` + `AllocationManager` + `HotBridge`。
 */
export class SandboxService {
  private readonly resolution: DataDirResolution
  private readonly vault: VaultManager
  private readonly store: ConfigStore
  private readonly allocations: AllocationManager
  private broken: string | null = null

  constructor(
    private readonly ctx: HostContext,
    private readonly hot: HotBridge,
    dataDir?: string,
  ) {
    this.resolution = dataDir === undefined ? resolveSandboxDataDir() : { dir: dataDir, from: 'env', reason: '由调用方显式指定' }
    try {
      this.vault = new VaultManager(this.resolution.dir)
      this.store = new ConfigStore(this.resolution.dir)
      this.allocations = new AllocationManager(this.store)
    } catch (err) {
      // 构造失败也要能启动：插件本身不该因为沙箱目录不可用就装不上
      this.broken = err instanceof Error ? err.message : String(err)
      // 下面三个字段的类型需要一个可赋值对象；用最小替身，所有读写都会先检查 this.broken
      const noopStore = { read: () => ({}), write: () => {} } as unknown as ConfigStore
      this.vault = new VaultManager(this.resolution.dir)
      this.store = noopStore
      this.allocations = new AllocationManager(noopStore)
    }
  }

  /** 本进程所在环境名与其 profiles 目录 —— 从 `ctx.baseUrl` 反推。 */
  private own(): { profile: string | null; profilesDir: string | null } {
    // 必须先用 hostBaseDir 归一化：`ctx.baseUrl` 是 `file://` URL，不是路径。
    // 直接 basename/dirname 会得到 `.\file:\C:\...` 这种垃圾（本服务第一版就踩了）。
    const base = hostBaseDir(this.ctx)
    if (base === null) return { profile: null, profilesDir: null }
    return { profile: basename(base), profilesDir: dirname(base) }
  }

  /** 整体状态。 */
  status(): SandboxStatus {
    const { profile, profilesDir } = this.own()
    const indexFile = join(this.resolution.dir, 'vault.json')
    const base: SandboxStatus = {
      dataDir: this.resolution.dir,
      dataDirFrom: this.resolution.from,
      dataDirReason: this.resolution.reason,
      storeDir: join(this.resolution.dir, 'vault_store'),
      indexExists: existsSync(indexFile),
      ownProfile: profile,
      profilesDir,
      count: 0,
    }
    if (this.broken !== null) return { ...base, error: `沙箱初始化失败：${this.broken}` }
    try {
      base.count = this.vault.list().length
      return base
    } catch (err) {
      return { ...base, error: `读取沙箱索引失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 条目列表（含起源标签与"能否更新"，子依赖保留 parentId 以便前端折叠）。 */
  list(): SandboxEntryView[] {
    if (this.broken !== null) return []
    let plugins: VaultPlugin[] = []
    try {
      plugins = this.vault.list()
    } catch {
      return []
    }
    return plugins.map((p) => {
      const origin = inferVaultOrigin(p)
      return {
        id: p.id,
        name: p.name,
        version: p.activeVersion ?? p.version,
        kind: p.kind,
        ...(p.parentId === undefined ? {} : { parentId: p.parentId }),
        ...(p.childOrigin === undefined ? {} : { childOrigin: p.childOrigin }),
        isChild: p.parentId !== undefined,
        originKind: origin.kind,
        originLabel: originLabel(origin),
        updatable: isUpdatableEntry(p),
        hasUpdate: p.hasUpdate === true,
        ...(p.latestVersion === undefined ? {} : { latestVersion: p.latestVersion }),
        installedProfiles: [...(p.installedProfiles ?? [])],
        ...(p.sizeBytes === undefined ? {} : { sizeBytes: p.sizeBytes }),
        ...(p.securityLevel === undefined ? {} : { securityLevel: p.securityLevel }),
      }
    })
  }

  /** 部署历史。 */
  history(profile?: string): DeploymentSnapshot[] {
    if (this.broken !== null) return []
    try {
      return this.vault.getHistory(profile)
    } catch {
      return []
    }
  }

  /** 空间收益指标。 */
  metrics(): DiskSavingsReport | null {
    const { profilesDir } = this.own()
    if (this.broken !== null || profilesDir === null) return null
    try {
      return this.vault.calculateDiskSavings(profilesDir)
    } catch {
      return null
    }
  }

  /** 检查更新（联网；调用方自行承担耗时）。 */
  async checkUpdates(): Promise<{ ok: boolean; checked: number; withUpdate: number; error?: string }> {
    if (this.broken !== null) return { ok: false, checked: 0, withUpdate: 0, error: this.broken }
    try {
      const results = await this.vault.checkUpdates()
      return { ok: true, checked: results.length, withUpdate: results.filter((r) => r.hasUpdate).length }
    } catch (err) {
      return { ok: false, checked: 0, withUpdate: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 回收未被任何环境链接的池目录。 */
  async garbageCollect(): Promise<{ ok: boolean; removedDirs: string[]; keptDirs: string[]; freedBytes: number; error?: string }> {
    const { profilesDir } = this.own()
    if (this.broken !== null || profilesDir === null) {
      return { ok: false, removedDirs: [], keptDirs: [], freedBytes: 0, error: this.broken ?? '无法确定 profiles 目录' }
    }
    try {
      const r = await this.vault.garbageCollect(profilesDir)
      return { ok: true, removedDirs: r.removedDirs, keptDirs: r.keptDirs ?? [], freedBytes: r.freedBytes }
    } catch (err) {
      return { ok: false, removedDirs: [], keptDirs: [], freedBytes: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 从各环境反向收割未纳管的插件。 */
  async harvest(): Promise<{ ok: boolean; harvested: number; scannedProfiles: number; error?: string }> {
    const { profilesDir } = this.own()
    if (this.broken !== null || profilesDir === null) {
      return { ok: false, harvested: 0, scannedProfiles: 0, error: this.broken ?? '无法确定 profiles 目录' }
    }
    try {
      const r = await this.vault.harvestFromProfiles(profilesDir)
      return { ok: true, harvested: r.harvested.length, scannedProfiles: r.totalProfilesScanned }
    } catch (err) {
      return { ok: false, harvested: 0, scannedProfiles: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 从沙箱移除（事务化；含"删母即删子""删子即删母"等已裁定语义）。 */
  async remove(
    ids: string[],
  ): Promise<{
    ok: boolean
    removed: number
    blocked: number
    failed: number
    /** 逐条结论，便于界面按条显示"被谁挡下"。 */
    results: { id: string; name?: string; status: string; reason?: string; dependents?: string[] }[]
    /** 声明层的清理结果（逐环境），让调用方能看到"补丁层也清干净了"。 */
    cleanup: { profile: string; purged: string[]; error?: string }[]
    /** 本次从**运行树**里热卸载掉的包（注入是即时的，移除也必须即时）。 */
    unmounted: HotResult[]
    error?: string
  }> {
    if (this.broken !== null) {
      return { ok: false, removed: 0, blocked: 0, failed: 0, results: [], cleanup: [], unmounted: [], error: this.broken }
    }
    const { profilesDir } = this.own()

    // ① 先留档：vault 里删掉之后就再也查不到"它曾在哪些环境里"了
    const targets: { id: string; name: string; profiles: string[] }[] = []
    try {
      const all = this.vault.list()
      for (const id of ids) {
        const hit = all.find((p) => p.id === id || p.name === id)
        if (hit !== undefined) targets.push({ id: hit.id, name: hit.name, profiles: [...(hit.installedProfiles ?? [])] })
      }
    } catch {
      /* 留档失败不阻断删除：清理阶段退化为"尽力而为"并如实报告 */
    }

    // ② 删 vault（传 profilesDir：连带解除各环境的 Junction 挂载与 package.json 声明）
    let r: Awaited<ReturnType<VaultManager['removeMany']>>
    try {
      r = await this.vault.removeMany(ids, profilesDir === null ? {} : { profilesDir })
    } catch (err) {
      return {
        ok: false,
        removed: 0,
        blocked: 0,
        failed: ids.length,
        results: [],
        cleanup: [],
        unmounted: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }

    // ③ 清声明层（补丁层 + 分配记录）—— 详见方法头注释：不做这一步会留下悬空补丁行
    const cleanup: { profile: string; purged: string[]; error?: string }[] = []
    if (profilesDir === null) {
      if (targets.some((t) => t.profiles.length > 0)) {
        cleanup.push({ profile: '(未知)', purged: [], error: '无法确定 profiles 目录，未能清理补丁层' })
      }
    } else {
      const profiles = [...new Set(targets.flatMap((t) => t.profiles))]
      for (const prof of profiles) {
        const names = targets.filter((t) => t.profiles.includes(prof)).map((t) => t.name)
        try {
          // 先摘掉分配记录，否则下次任何 applyProfile 都会把它们再加回补丁层
          for (const a of this.allocations.list()) {
            if (a.profile === prof && names.includes(a.pluginId)) this.allocations.remove(a.id)
          }
          // 再用 removedIds 把补丁行抹掉（applyProfile 会剔除 managedIds ∪ removedIds）
          this.allocations.applyProfile(profilesDir, prof, names)
          cleanup.push({ profile: prof, purged: names })
        } catch (err) {
          cleanup.push({ profile: prof, purged: names, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    const cleanupFailed = cleanup.some((c) => c.error !== undefined)

    // ④ 热卸载：本进程里如果正挂着这些包，一并摘掉。
    //
    // 为什么必须有这一步：`inject` 是"物理 + 声明 + **热装载**"，若 `remove` 只做前两步，
    // 插件会**继续在运行中的 dsh 里活着**直到下次重启 —— 用户看到的是"我明明移除了，
    // 它还在跑"，这是最难自查的一类状态不一致。既然注入是即时的，移除也必须即时。
    const unmounted: HotResult[] = []
    try {
      const live = new Set(this.hot.list().filter((e) => !e.disabled).map((e) => e.name))
      for (const t of targets) {
        if (live.has(t.name)) unmounted.push(await this.hot.unmount(t.name))
      }
    } catch {
      /* 热卸载失败不影响沙箱侧结论：补丁层已清，下次启动即不再加载 */
    }

    return {
      ok: r.failed === 0 && r.blocked === 0 && !cleanupFailed,
      removed: r.removed,
      blocked: r.blocked,
      failed: r.failed,
      results: r.results.map((x) => ({
        id: x.id,
        ...(x.name === undefined ? {} : { name: x.name }),
        status: x.status,
        ...(x.reason === undefined ? {} : { reason: x.reason }),
        ...(x.dependents === undefined ? {} : { dependents: x.dependents }),
      })),
      cleanup,
      unmounted,
    }
  }

  /** 更新单个沙箱插件到指定/最新版本。 */
  async updatePlugin(id: string, version?: string): Promise<{ ok: boolean; fromVersion?: string; toVersion?: string; error?: string }> {
    const { profilesDir } = this.own()
    if (this.broken !== null) return { ok: false, error: this.broken }
    try {
      const r = await this.vault.updatePlugin(id, version, profilesDir ?? undefined)
      return { ok: r.ok, fromVersion: r.fromVersion, toVersion: r.toVersion }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * **注入（分部 G 的核心）**：四阶段，且如实报告生效范围。
   *
   * ```
   * ① preflight  —— 目标环境与物理源是否就位（复用 deployToProfile 内部的前置干跑校验）
   * ② physical   —— junction 零拷贝挂载 + package.json 声明 + bundles 门控（失败自动回滚）
   * ③ declared   —— 写 <profile>/cordis.patch.yml（与启动器分配页同一条 applyProfile 路径）
   * ④ hotMounted —— 若目标就是本进程所在环境，直接进运行树（零重启）；否则明确报告"需启动该环境"
   * ```
   *
   * @param pluginId - 沙箱条目 id 或包名。
   * @param profile - 目标环境名（缺省为本进程所在环境）。
   * @param version - 指定版本；缺省用沙箱当前活跃版本。
   */
  async inject(pluginId: string, profile?: string, version?: string): Promise<InjectResult> {
    const { profile: own, profilesDir } = this.own()
    const target = profile ?? own ?? ''
    const phases: InjectPhases = {
      preflight: { ok: false, message: '未执行' },
      physical: { ok: false, message: '未执行', deployed: [], companions: [] },
      declared: { ok: false, message: '未执行' },
      hotMounted: { attempted: false, ok: false, message: '未执行', results: [] },
    }
    const fail = (message: string): InjectResult => ({
      ok: false,
      pluginId,
      profile: target,
      effectiveness: 'failed',
      message,
      phases,
    })

    if (this.broken !== null) return fail(`沙箱不可用：${this.broken}`)
    if (typeof pluginId !== 'string' || pluginId.trim() === '') return fail('缺少 pluginId')
    if (target === '') return fail('无法确定目标环境（本进程的 profile 未知，且调用方未指定）')
    if (profilesDir === null) return fail('无法确定 profiles 目录')
    if (!existsSync(join(profilesDir, target, 'package.json'))) {
      phases.preflight = { ok: false, message: `目标环境不存在：${join(profilesDir, target)}` }
      return fail(`目标环境不存在：${target}`)
    }
    phases.preflight = { ok: true, message: `目标环境 ${target} 就位（物理源校验在下一阶段内联执行）` }

    // ---------- ② 物理 + 声明（deployToProfile 自身已是事务化：干跑 → 原子写 → 校验 → 回滚）----------
    let report: Awaited<ReturnType<VaultManager['deployToProfile']>>
    try {
      report = await this.vault.deployToProfile(pluginId, target, profilesDir, version)
    } catch (err) {
      phases.physical = { ok: false, message: err instanceof Error ? err.message : String(err), deployed: [], companions: [] }
      return fail(`注入失败（物理阶段抛错）：${phases.physical.message}`)
    }
    const deployed = [...report.deployed, ...report.companionAdded, ...(report.derivedCompanions ?? [])]
    phases.physical = {
      ok: report.ok,
      message: report.ok ? `已挂载 ${deployed.length} 个包` : (report.error ?? '注入未完成'),
      deployed: report.deployed,
      companions: [...report.companionAdded, ...(report.derivedCompanions ?? [])],
    }
    if (!report.ok) return fail(report.error ?? '注入未完成（物理阶段）')

    // ---------- ③ 写补丁层（与启动器分配页完全相同的一条路径）----------
    try {
      for (const name of deployed) {
        this.allocations.allocate(target, name, name)
      }
      const patchPath = this.allocations.applyProfile(profilesDir, target)
      phases.declared = { ok: true, message: '已写入 cordis.patch.yml', patchPath }
    } catch (err) {
      // 物理已成功、声明失败：**不谎报成功**，明确说明"插件已挂载但未声明"；
      // 同时把本次刚建的分配记录回滚掉 —— 留着它们会让**下一次**任意 applyProfile
      // 把这些行重新写回补丁层（那时用户已经不知道它们从哪来了）。
      for (const name of deployed) {
        try {
          for (const a of this.allocations.list()) {
            if (a.profile === target && a.pluginId === name) this.allocations.remove(a.id)
          }
        } catch {
          /* 回滚失败不影响主结论，下面的文案已经把状态说清楚 */
        }
      }
      phases.declared = { ok: false, message: err instanceof Error ? err.message : String(err) }
      return {
        ok: false,
        pluginId,
        profile: target,
        effectiveness: 'registered-only',
        message: `插件已挂载到 ${target}，但写补丁层失败：${phases.declared.message}。已回滚本次分配记录；可到启动器的分配页重试`,
        phases,
      }
    }

    // ---------- ④ 热装载 ----------
    if (own === null || target !== own) {
      phases.hotMounted = {
        attempted: false,
        ok: false,
        message: `目标环境 ${target} 不是当前运行中的环境（${own ?? '未知'}），本进程无法为它热装载`,
        results: [],
      }
      return {
        ok: true,
        pluginId,
        profile: target,
        effectiveness: 'needs-profile-start',
        message: `已注入 ${target} 并写入补丁层；该环境下次启动时生效（当前运行的是 ${own ?? '另一个环境'}）`,
        phases,
      }
    }

    const results: HotResult[] = []
    for (const name of deployed) {
      results.push(await this.hot.mount(name))
    }
    const allOk = results.length > 0 && results.every((r) => r.ok)
    phases.hotMounted = {
      attempted: true,
      ok: allOk,
      message: allOk
        ? `已热装载 ${results.length} 个包（未重启进程）`
        : `部分包未能热装载：${results.filter((r) => !r.ok).map((r) => `${r.target}(${r.code})`).join('、')}`,
      results,
    }
    if (allOk) {
      return {
        ok: true,
        pluginId,
        profile: target,
        effectiveness: 'live',
        message: `已注入并**热装载**到 ${target}：立即生效，未重启 dsh 进程`,
        phases,
      }
    }
    return {
      ok: true,
      pluginId,
      profile: target,
      effectiveness: 'registered-only',
      message: `已注入并写入补丁层，但热装载未完全成功（${phases.hotMounted.message}）；该环境下次启动时必然生效`,
      phases,
    }
  }

  /** 供自检面板显示的原始数据目录解析结果。 */
  dataDirInfo(): DataDirResolution {
    return this.resolution
  }
}
