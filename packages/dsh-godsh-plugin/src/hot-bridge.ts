/**
 * 热装载桥（Hot Bridge）—— 分部 G/H 的执行体。
 *
 * 背景（G0 实测结论，见 `09_输入文档/新文档/G0实验结论-活层装载通道.md`）
 * ---------------------------------------------------------------------
 * dsh 的 `profile-boot` 里有一段「若 `patchReload === 'live'` 就用 HMR 监听
 * `<profile>/cordis.patch.yml` 并整栈重放」的逻辑（`watchUserPatches` →
 * `hmr.registerConfig` → 根 Include entry 的 `entry.update`）。但**本机实测该监听不生效**：
 * 写入新 row / 对已存在 row 做 id 定向 disabled / 写入非法 YAML，三类探针在**不带**与
 * **带** `--expose-internals` 两种启动下都产生零可观测效果（图无变化、dsh 输出零增长）。
 * 同时实测确认 `--expose-internals` 在本机可用、SSE `/plugins/events` 通路是活的 ——
 * 所以缺口不在那两个前提上。
 *
 * 本模块的立场**不是**去复刻那段失效的监听，而是换一条可验证的路：
 *
 *   **在插件自己的 `apply()` 里直接操作运行中的 Cordis loader。**
 *
 * 为什么这条路成立，而 dsh 自己那条不成立：
 *   - 我们的 `apply()` 是**被 loader 调用**的，此刻 root fiber 必然已经 ACTIVE，
 *     不存在 profile-boot 那段守卫"检查得太早"的问题（G0 推断的缺口正在那里）；
 *   - `ctx.loader.create / entry.update / entry.dispose` 都是 loader 的公开能力，
 *     不需要 `--expose-internals`，也不需要 dsh 私有的 `bootstrapIncludes` WeakMap；
 *   - 新增一个声明了 `dsh.client` 的 row 后，`dsh-client-modules` 会监听
 *     `internal/plugin` 做**每包增量对账**、并把新条目并进客户端模块图
 *     （实测：`/plugins/events` 的 `graph` 帧带完整 `entries[]`，每项含可加载 url）。
 *
 * 与「活层补丁文件」的关系（不冲突，各有分工）
 * ------------------------------------------
 *   - `cordis.patch.yml` 仍是**持久记录**：它决定下次冷启动时装什么（由 godsh 的分配层写）；
 *   - 本模块负责**本次运行**的即时生效：直接建/禁/删 loader 条目。
 * 两者语义等价但生命周期不同，因此本模块的操作是**幂等**的，不与文件互相覆盖。
 *
 * 诚实边界（**不由本模块解决，必须由界面如实显示**）
 * ------------------------------------------------
 *   - 需要改 `dsh.profile.bundles` 的操作（bundle 层元组变化）仍然是冷层，需重启；
 *   - 替换一个已被下游缓存的服务实例（例如换 LLM provider）需重启；
 *   - 插件在 boot 时 spawn 的 MCP stdio 子进程、以及装在**全局** dsh 树而非 profile 的插件，需重启。
 * 这些都在 `RestartReason` 里显式建模，不允许被显示成"成功"。
 *
 * 安全纪律
 * --------
 *   - 模块内**任何**函数都不得向外抛异常：它跑在用户的 dsh 进程里，抛出去可能把整棵树带崩。
 *     所有对外入口都返回结构化结果（`{ ok, error }`），错误只进状态与日志。
 *   - 不做任何猜测性写入：找不到目标条目就如实返回 `not-found`，不"顺手重建"。
 *
 * @module @godsh/dsh/hot-bridge
 */

import { asObjectWith, type HostContext, type LoaderEntryLike } from './host-types.js'

/** 热装载后端。`loader` = 直接操作运行中的 Cordis loader（本机可用）；`none` = 都不可用。 */
export type HotBackend = 'loader' | 'none'

/** 需要重启的具体原因（界面必须逐条如实显示，不得含糊）。 */
export type RestartReason =
  | 'no-loader'
  | 'bundle-layer-change'
  | 'service-consumer-cached'
  | 'mcp-stdio-spawn'
  | 'global-tree-plugin'

/** 一次操作的结论。 */
export interface HotResult {
  ok: boolean
  /** 操作对象（包名或 row id）。 */
  target: string
  /** 结构化状态码，便于界面与测试断言（断言码，不断言文案）。 */
  code: 'ok' | 'not-found' | 'already-in-desired-state' | 'not-directly-loadable' | 'needs-restart' | 'error'
  /** 失败时的人类可读原因（中文）。 */
  error?: string
  /** `code === 'needs-restart'` 时的具体原因。 */
  restartReason?: RestartReason
  /** 观测到的运行态快照（用于"结论可核对"，而不是只给一句话）。 */
  observed?: HotEntryView[]
}

/** 运行树里一个条目的可观测视图。 */
export interface HotEntryView {
  /** 包名（`options.name`）。 */
  name: string
  /** 该条目在 loader 里的 id（可能与行 id 相同、也可能由 loader 生成）。 */
  entryId?: string
  disabled: boolean
  hasFiber: boolean
  /**
   * 该条目对象上实际可用的方法名（诊断用）。
   *
   * 为什么要把这个暴露出来：不同 dsh 版本的 Loader entry 暴露的方法集不同 ——
   * 实测 `entry.dispose` 在本机**不存在**，所以卸载必须走别的路径。把这个列出来，
   * 界面与排障脚本就不必靠猜（本项目已经因为"猜 API 存在"吃过一次假结论）。
   */
  methods: string[]
}

/** 桥的自检快照 —— 用来回答「dsh 自己的活层监听到底为什么没生效」。 */
export interface BridgeProbe {
  backend: HotBackend
  loaderPresent: boolean
  entryCount: number
  /** `ctx.get('hmr')` 是否存在（dsh 的 HMR 服务）。 */
  hmrPresent: boolean
  /** 是否能在 loader 条目里找到 patch 覆盖层那个「根 Include」。 */
  includeFound: boolean
  /** 根 Include 的包名（找到时给出）。 */
  includeName: string | null
  /** `--expose-internals` 是否在 execArgv 里（HMR 服务的构造前置条件）。 */
  exposeInternals: boolean
  /**
   * HMR 服务与根 Include 条目**是否同时可定位**。
   *
   * ⚠️ 这**不等于**「dsh 自己的补丁层监听在生效」。首轮实测（G0，6 次观测）表明：
   * 即便这个条件为真（带 `--expose-internals` 时确实 `hmr` 在位、include 也能找到），
   * 往 `<profile>/cordis.patch.yml` 写入新 row / id 定向 disabled / 非法 YAML，
   * 三类探针都产生**零可观测效果**。所以本字段只回答"前提条件在不在"，
   * 关于"监听是否真的在重放"的结论必须以写文件实测为准，不能由本字段推出。
   */
  hmrAndIncludeAvailable: boolean
  notes: string[]
}

/** 根 Include 覆盖层的候选包名（按优先级）。 */
const INCLUDE_CANDIDATES = ['@deepseek-ai/cordis-plugin-include'] as const

/** 判断某个条目的 config 是否像 patch 覆盖层（含数组型 `patches`）。 */
function looksLikeIncludeConfig(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false
  return Array.isArray((config as { patches?: unknown }).patches)
}

/**
 * 在 loader 条目里找「根 Include 覆盖层」。
 *
 * dsh 自己用 `@deepseek-ai/dsh-app-boot` 里一个**模块私有**的 WeakMap（`bootstrapIncludes`）
 * 记这个条目，那个东西没有被导出，所以我们只能从公开的 `entries()` 反查。
 */
function findIncludeEntry(entries: LoaderEntryLike[]): LoaderEntryLike | null {
  for (const name of INCLUDE_CANDIDATES) {
    const hit = entries.find((e) => e.options.name === name)
    if (hit !== undefined) return hit
  }
  // 退化判据：config 里带数组型 patches 的那一条就是覆盖层
  return entries.find((e) => looksLikeIncludeConfig(e.options.config)) ?? null
}

/**
 * 运行树的热装载桥。
 *
 * 生命周期：由宿主半在 `apply()` 里建一个实例并 `provide` 出去；它本身不持有定时器、
 * 不注册全局副作用，所有操作都是「被调用时才动」。
 */
export class HotBridge {
  private readonly log: string[] = []

  constructor(
    private readonly ctx: HostContext,
    /** 该 profile 的补丁文件绝对路径；仅用于自检与提示，不作为写入目标。 */
    private readonly patchFile: string
  ) {}

  /** 读取 loader 的最小面；不可用时返回 `null`。 */
  private loader(): ReturnType<typeof asObjectWith<'entries'>> | null {
    return asObjectWith(this.ctx.get('loader'), 'entries')
  }

  /** 列出运行树里的条目（只读）。 */
  list(): HotEntryView[] {
    const loader = this.loader()
    if (loader === null) return []
    const out: HotEntryView[] = []
    try {
      for (const entry of loader.entries() as Iterable<LoaderEntryLike>) {
        const name = typeof entry.options.name === 'string' ? entry.options.name : ''
        if (name === '') continue
        out.push({
          name,
          ...(typeof entry.options.id === 'string' ? { entryId: entry.options.id } : {}),
          disabled: entry.options.disabled === true,
          hasFiber: entry.fiber !== undefined && entry.fiber !== null,
          methods: Object.keys(entry as unknown as Record<string, unknown>)
            .filter((k) => typeof (entry as unknown as Record<string, unknown>)[k] === 'function')
            .sort(),
        })
      }
    } catch (error) {
      this.note(`list() 遍历 entries 失败：${describe(error)}`)
    }
    return out
  }

  /**
   * 自检：回答「dsh 的活层监听为什么没生效」以及「本桥能否工作」。
   *
   * 这是把 G0 的**推断**变成**树内实测**的手段 —— G0 只能从外面观察，这里能直接看
   * `hmr` 服务在不在、include 条目找不找得到、execArgv 有没有那个 flag。
   */
  probe(): BridgeProbe {
    const notes: string[] = []
    const loader = this.loader()
    const entries = this.list()
    const hmrPresent = this.ctx.get('hmr') !== undefined
    const includeEntry = loader === null ? null : findIncludeEntry([...(loader.entries() as Iterable<LoaderEntryLike>)])
    const exposeInternals = process.execArgv.includes('--expose-internals')

    if (loader === null) notes.push('ctx.get("loader") 不可用 —— 本桥无法工作，需要重启或以其它方式装载')
    if (!hmrPresent) {
      notes.push('ctx.get("hmr") 不存在 —— dsh 的 HMR 服务没有挂载')
      if (!exposeInternals) {
        notes.push('且 process.execArgv 里没有 --expose-internals：cordis-plugin-hmr 的构造函数会直接抛错，所以它不可能被创建')
      }
    }
    if (includeEntry === null && loader !== null) notes.push('在 loader 条目里找不到根 Include 覆盖层（config.patches 为数组的那一条）')
    if (includeEntry !== null) notes.push(`根 Include 条目 = ${String(includeEntry.options.name ?? '(无名)')}`)

    // 「dsh 自己的活层监听是否在生效」**不能**由本方法推断。
    // 这里只如实汇报两个前提条件，并把 G0 的实测结论作为注记带上 —— 否则界面会读成
    // "监听可用"，而 G0 已经量到它不重放（这正是本项目反复吃过的「审计跑过却什么都没发现」）。
    const hmrAndIncludeAvailable = hmrPresent && includeEntry !== null
    if (hmrAndIncludeAvailable) {
      notes.push(
        'HMR 服务与根 Include 均已就位；但 G0 实测：即便两者就位，写入 cordis.patch.yml 仍不产生任何效果 —— ' +
          '所以"活层监听是否真的在重放"必须以写文件实测为准，本字段只说明前提条件具备'
      )
    } else {
      notes.push(`前提条件不全（hmr=${String(hmrPresent)} include=${String(includeEntry !== null)}），写入 ${this.patchFile} 必然不会被重放`)
    }

    return {
      backend: loader === null ? 'none' : 'loader',
      loaderPresent: loader !== null,
      entryCount: entries.length,
      hmrPresent,
      includeFound: includeEntry !== null,
      includeName: includeEntry === null ? null : (typeof includeEntry.options.name === 'string' ? includeEntry.options.name : null),
      exposeInternals,
      hmrAndIncludeAvailable,
      notes,
    }
  }

  /**
   * 热装载一个包：在运行树里建一个 loader 条目。
   *
   * 幂等：已在树里（且未被禁用）时返回 `already-in-desired-state`，不重复建条目
   * —— 重复建会产生同 id 的两个 fiber，是本项目历史上"注入坏状态"的一类来源。
   *
   * @param name - 包名（loader 会按 profile 的解析锚点把它变成模块）。
   * @param options - `id` 显式指定条目 id（默认用包名）；`config` 传给插件。
   */
  async mount(name: string, options: { id?: string; config?: unknown } = {}): Promise<HotResult> {
    const loader = this.loader()
    if (loader === null) {
      return { ok: false, target: name, code: 'needs-restart', restartReason: 'no-loader', error: 'loader 服务不可用，无法热装载' }
    }
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, target: name, code: 'error', error: '包名不能为空' }
    }

    const existing = this.list().find((e) => e.name === name)
    if (existing !== undefined && !existing.disabled) {
      return {
        ok: true,
        target: name,
        code: 'already-in-desired-state',
        observed: [existing],
      }
    }

    try {
      const create = asObjectWith(loader, 'create')
      if (create === null) {
        return { ok: false, target: name, code: 'error', error: 'loader 没有 create 方法（不是预期的 Cordis loader）' }
      }
      const request: { id?: string; name: string; config?: unknown } = { name }
      if (options.id !== undefined) request.id = options.id
      if (options.config !== undefined) request.config = options.config
      await (create as unknown as { create(o: typeof request): Promise<void> }).create(request)
      const after = this.list()
      const hit = after.find((e) => e.name === name)
      if (hit === undefined) {
        return {
          ok: false,
          target: name,
          code: 'error',
          error: 'loader.create 已返回，但树里没有出现该条目 —— 装载未生效',
          observed: after,
        }
      }
      this.note(`已热装载 ${name}`)
      return { ok: true, target: name, code: 'ok', observed: [hit] }
    } catch (error) {
      const message = describe(error)
      this.note(`热装载 ${name} 失败：${message}`)
      return { ok: false, target: name, code: 'error', error: message }
    }
  }

  /**
   * 热禁用/启用一个已存在的条目（id 定向）。
   *
   * @param rowId - loader 条目的 id（**不是**包名；patch 行 id 通常是短名如 `ui-open-in-app`）。
   */
  async setDisabled(rowId: string, disabled: boolean): Promise<HotResult> {
    const entry = this.findByRowId(rowId)
    if (entry === null) {
      return { ok: false, target: rowId, code: 'not-found', error: `运行树里找不到条目 id = ${rowId}` }
    }
    if ((entry.options.disabled === true) === disabled) {
      return { ok: true, target: rowId, code: 'already-in-desired-state' }
    }
    try {
      await entry.update({ disabled })
      this.note(`已将 ${rowId} 的 disabled 置为 ${String(disabled)}`)
      return { ok: true, target: rowId, code: 'ok' }
    } catch (error) {
      const message = describe(error)
      this.note(`切换 ${rowId} 的 disabled 失败：${message}`)
      return { ok: false, target: rowId, code: 'error', error: message }
    }
  }

  /**
   * 热卸载：按包名找到条目并让它从运行树里消失。
   *
   * 为什么不是一句 `entry.dispose()`：**实测本机 dsh 0.1.5-rc.1 的 loader entry 上
   * 没有 `dispose`**（调用会抛 `TypeError: entry.dispose is not a function`，
   * 这个是首轮 H1 实验里真实踩到的）。所以这里按能力依次尝试多条路径，并**如实报告
   * 用的是哪一条**，而不是假定某一条存在：
   *
   *   1. `entry.dispose()`        —— 某些 dsh 版本直接给条目这个方法；
   *   2. `entry.fiber.dispose()`  —— 销毁条目对应的 fiber（最接近"卸载"的语义）；
   *   3. `loader.remove(entry)`   —— 有些 loader 把移除放在 loader 上；
   *   4. `entry.update({ disabled: true })` —— 最后的降级：**不是真卸载**，
   *      而是把条目禁用（插件不再运行、但仍留在树里）。这条会在返回里标注，
   *      绝不冒充"已卸载"。
   */
  async unmount(name: string): Promise<HotResult> {
    const entry = this.findByName(name)
    if (entry === null) {
      return { ok: false, target: name, code: 'not-found', error: `运行树里找不到包 ${name}` }
    }
    const attempts: string[] = []

    // 路径 1：entry.dispose()
    const withDispose = asObjectWith(entry, 'dispose')
    if (withDispose !== null) {
      try {
        await (withDispose as unknown as { dispose(): Promise<void> }).dispose()
        attempts.push('entry.dispose')
      } catch (error) {
        attempts.push(`entry.dispose 失败(${describe(error)})`)
      }
    } else {
      attempts.push('entry.dispose 不存在')
    }
    if (!this.list().some((e) => e.name === name)) {
      this.note(`已热卸载 ${name}（路径：${attempts.join(' / ')}）`)
      return { ok: true, target: name, code: 'ok', observed: [] }
    }

    // 路径 2：entry.fiber.dispose()
    const fiber = (entry as unknown as { fiber?: unknown }).fiber
    const fiberDispose = asObjectWith(fiber, 'dispose')
    if (fiberDispose !== null) {
      try {
        await (fiberDispose as unknown as { dispose(): Promise<void> }).dispose()
        attempts.push('entry.fiber.dispose')
      } catch (error) {
        attempts.push(`entry.fiber.dispose 失败(${describe(error)})`)
      }
    } else {
      attempts.push('entry.fiber.dispose 不存在')
    }
    if (!this.list().some((e) => e.name === name)) {
      this.note(`已热卸载 ${name}（路径：${attempts.join(' / ')}）`)
      return { ok: true, target: name, code: 'ok', observed: [] }
    }

    // 路径 3：loader.remove(id)
    // 注意：**实测** `loader.remove` 要的是 **字符串 id**，不是条目对象 ——
    // 传对象会得到 `TypeError: id.split is not a function`（它内部按 id 拼路径）。
    // 这是首轮实验的真实报错，别再传对象。
    const loaderWithRemove = asObjectWith(this.ctx.get('loader'), 'remove')
    const entryId = typeof entry.options.id === 'string' ? entry.options.id : null
    if (loaderWithRemove !== null && entryId !== null) {
      try {
        await (loaderWithRemove as unknown as { remove(id: string): Promise<void> }).remove(entryId)
        attempts.push(`loader.remove(${entryId})`)
      } catch (error) {
        attempts.push(`loader.remove(${entryId}) 失败(${describe(error)})`)
      }
    } else {
      attempts.push(loaderWithRemove === null ? 'loader.remove 不存在' : 'entry.options.id 不是字符串，无法调用 loader.remove')
    }
    if (!this.list().some((e) => e.name === name)) {
      this.note(`已热卸载 ${name}（路径：${attempts.join(' / ')}）`)
      return { ok: true, target: name, code: 'ok', observed: [] }
    }

    // 路径 4：降级为禁用 —— 必须如实标注，不得冒充已卸载
    try {
      await entry.update({ disabled: true })
      attempts.push('降级为 disabled=true')
      const stillThere = this.list().find((e) => e.name === name)
      this.note(`未能真正卸载 ${name}，已降级为禁用（路径：${attempts.join(' / ')}）`)
      return {
        ok: false,
        target: name,
        code: 'needs-restart',
        restartReason: 'service-consumer-cached',
        error: `本机 loader 不提供可用的移除路径，已把该条目降级为「禁用」而不是卸载。尝试记录：${attempts.join(' / ')}`,
        observed: stillThere === undefined ? [] : [stillThere],
      }
    } catch (error) {
      attempts.push(`降级禁用也失败(${describe(error)})`)
      return {
        ok: false,
        target: name,
        code: 'error',
        error: `卸载失败且无法降级为禁用。尝试记录：${attempts.join(' / ')}`,
      }
    }
  }

  /** 内部日志（最近 200 条），供界面与排障读取。 */
  recentLog(): string[] {
    return [...this.log]
  }

  private note(line: string): void {
    this.log.push(`${new Date().toISOString()} ${line}`)
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200)
    try {
      this.ctx.logger?.info(`[godsh] ${line}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  private allEntries(): LoaderEntryLike[] {
    const loader = this.loader()
    if (loader === null) return []
    try {
      return [...(loader.entries() as Iterable<LoaderEntryLike>)]
    } catch {
      return []
    }
  }

  private findByName(name: string): LoaderEntryLike | null {
    return this.allEntries().find((e) => e.options.name === name) ?? null
  }

  private findByRowId(rowId: string): LoaderEntryLike | null {
    // 先按 loader 条目的 id 匹配，再退化按包名匹配 —— 两者在不同 dsh 版本里都可能承载"行 id"
    const byId = this.allEntries().find((e) => e.options.id === rowId)
    if (byId !== undefined) return byId
    return this.findByName(rowId)
  }
}

/** 把任意抛出物渲染成一行可读文本（绝不再次抛）。 */
export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
