/**
 * `@godsh/dsh` 浏览器半 —— 运行在 dsh web GUI 内，注册一个真实的设置页。
 *
 * 为什么用 `settings.section`
 * -------------------------
 * 实测全 dsh 树里的 slot 名：`settings.section` **真实存在**（`dsh-client-ui-agent-preset`、
 * `dsh-client-ui-settings-plugins` 等 4 处注册/渲染），而本仓库旧插件用的
 * `workbench.sidebar.item` 与 `global.overlay` **全树 0 命中** —— 那两块界面从来没有渲染过。
 * 所以这里只挂被验证存在的那个槽位。
 *
 * 挂载方式（与 `dsh-config-manager` / `dsh-ssh` 同构）
 * --------------------------------------------------
 *   `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))`
 * —— 声明未到账前不注册，声明塌缩时自动移除，重声明后自动重挂。
 *
 * React 从哪来
 * -----------
 * 从模块加载器的 `require` 拿（它在 factory 里被注入）。本文件**不 import react**，
 * 因此构建产物不会把 React 打进来 —— 浏览器侧只有一份 React，由平台 seed 提供。
 * 这也是 dsh 客户端 bundle 的既成纪律：bundle 必须自包含，但 React 系必须是外部依赖。
 *
 * 本文件刻意写成 `.ts` + `createElement`（而不是 `.tsx`）：仓库根 `tsconfig.json` 的
 * include 只覆盖 `packages` 下各个包的 `src` 里的 `.ts`，`.tsx` **不在**根类型门内；
 * 用 `.ts` 才能保证它被 `pnpm typecheck` 覆盖。
 *
 * @module @godsh/dsh/client
 */

/** 客户端插件名（Cordis 客户端约定，与宿主半同名）。 */
export const name = 'godsh'

/** 需要 slots。locale 是**可选**的（拿不到就退回内置中文文案），故不写进 inject。 */
export const inject = ['slots']

/** 与宿主半共用同一个前缀（宿主半 `routes.ts` 的 `GODSH_API_PREFIX`）。改一处即断。 */
const API_PREFIX = '/api/dsh-godsh'

/**
 * 模块加载器注入的 `require`。
 *
 * 构建产物是 CJS，`require` 由 `window.__ModuleLoader__` 的 factory 提供；在 TS 里声明它
 * 是为了让类型门知道这个符号存在（运行时由加载器保证）。
 */
declare const require: (id: string) => unknown

/** 本文件真正用到的 React 面（自己声明，避免为一个面板引入 @types/react 依赖）。 */
interface ReactElementLike {
  type: unknown
  props: unknown
  key: unknown
}
type ReactNodeLike = ReactElementLike | string | number | null | undefined | boolean
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: ReactNodeLike[]): ReactElementLike
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}

/** 面板文案（zh 源；dsh 的 locale 未接时直接用这一份）。 */
const ZH = {
  sectionLabel: 'godsh 插件沙箱',
  title: 'godsh · 热装载桥',
  backend: '后端',
  entries: '运行树条目',
  patchFile: '补丁文件',
  notes: '自检',
  refresh: '刷新',
  loading: '正在读取…',
  failed: '读取失败',
} as const

/** 宿主半 `/api/dsh-godsh/probe` 的响应形状（只声明用到的字段）。 */
interface ProbeView {
  backend: string
  loaderPresent: boolean
  entryCount: number
  hmrPresent: boolean
  includeFound: boolean
  exposeInternals: boolean
  hmrAndIncludeAvailable: boolean
  notes: string[]
}

/** 面板状态。 */
interface PanelState {
  loading: boolean
  error: string | null
  probe: ProbeView | null
}

/**
 * 读取宿主半的自检快照。
 *
 * 失败**不抛**：设置页里任何一个抛出的 promise 都会让整页空白，而这是"插件把宿主界面弄坏"
 * 的典型方式。所以这里一律收敛成 `{ error }`。
 */
async function loadProbe(): Promise<{ probe: ProbeView | null; error: string | null }> {
  try {
    const res = await fetch(`${API_PREFIX}/probe`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return { probe: null, error: `HTTP ${String(res.status)}` }
    const body = (await res.json()) as { ok?: boolean; probe?: ProbeView; error?: string }
    if (body.ok !== true || body.probe === undefined) return { probe: null, error: body.error ?? '响应缺少 probe 字段' }
    return { probe: body.probe, error: null }
  } catch (error) {
    return { probe: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** godsh 面板（设置页里的一个 section）。 */
function GodshPanel(props: { t?: (key: keyof typeof ZH) => string }): ReactElementLike {
  const React = require('react') as ReactLike
  const t = (key: keyof typeof ZH): string => props.t?.(key) ?? ZH[key]
  const [state, setState] = React.useState<PanelState>({ loading: true, error: null, probe: null })

  const refresh = (): void => {
    setState((prev) => ({ ...prev, loading: true }))
    void loadProbe().then(({ probe, error }) => {
      setState({ loading: false, error, probe })
    })
  }

  React.useEffect(() => {
    refresh()
    // 只在挂载时拉一次：这是自检面板，不做轮询（轮询会掩盖"没有事件驱动刷新"这类问题）
  }, [])

  const h = React.createElement
  const children: ReactNodeLike[] = []

  children.push(h('div', { key: 'title', className: 'card-title' }, t('title')))

  if (state.loading) children.push(h('div', { key: 'loading', className: 'muted' }, t('loading')))
  if (state.error !== null) children.push(h('div', { key: 'err', className: 'muted' }, `${t('failed')}: ${state.error}`))

  const probe = state.probe
  if (probe !== null) {
    children.push(
      h('div', { key: 'backend', className: 'row' }, `${t('backend')}: ${probe.backend}`),
      h('div', { key: 'entries', className: 'row' }, `${t('entries')}: ${String(probe.entryCount)}`),
      h(
        'div',
        { key: 'flags', className: 'row' },
        `loader=${String(probe.loaderPresent)} hmr=${String(probe.hmrPresent)} include=${String(probe.includeFound)} expose-internals=${String(probe.exposeInternals)}`
      ),
      h(
        'div',
        { key: 'watcher', className: 'row' },
        `hmr+include 就位=${String(probe.hmrAndIncludeAvailable)}（≠ 补丁层监听在重放，见下方注记）`
      ),
      h('pre', { key: 'notes', className: 'log-viewer' }, probe.notes.join('\n'))
    )
  }

  children.push(
    h(
      'button',
      { key: 'refresh', className: 'btn sm', type: 'button', onClick: refresh },
      t('refresh')
    )
  )

  return h('div', { className: 'card godsh-panel' }, ...children)
}

/** 客户端上下文（只声明用到的成员）。 */
export interface GodshClientContext {
  slots?: {
    inject(
      slot: string,
      factory: () => unknown
    ): void
    register(registration: Record<string, unknown>, component: unknown): unknown
  }
  locale?: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: string) => string
  }
  effect?(callback: () => (() => void) | void, label?: string): void
  logger?: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

/**
 * 客户端入口：注册 `settings.section`。
 *
 * @param ctx - dsh 的客户端根上下文。
 */
export function apply(ctx: GodshClientContext): void {
  if (ctx.slots === undefined) {
    ctx.logger?.warn('[godsh] 客户端上下文缺少 slots，界面未注册（不影响宿主半）')
    return
  }

  // locale 是可选能力：注册成功就用官方翻译器，失败就退回内置中文
  let t: ((key: keyof typeof ZH) => string) | undefined
  try {
    if (ctx.locale !== undefined) {
      ctx.locale.register('godsh', { zh: { ...ZH }, en: { ...ZH } })
      const bound = ctx.locale.bind('godsh')
      t = (key) => bound(key)
    }
  } catch {
    t = undefined
  }

  const label = t?.('sectionLabel') ?? ZH.sectionLabel
  const registration: Record<string, unknown> = {
    name: 'settings.section',
    id: 'godsh',
    order: 55,
    label: () => label,
  }
  if (t !== undefined) registration.locale = 'godsh'

  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots?.register(registration, (props: { t?: (key: keyof typeof ZH) => string }) =>
        GodshPanel(t === undefined ? props : { ...props, t })
      )
    )
  } catch (error) {
    ctx.logger?.warn(`[godsh] 注册 settings.section 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
