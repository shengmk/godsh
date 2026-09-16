/**
 * `@godsh/dsh` 浏览器半 —— 运行在 dsh web GUI 内，注册一个真实的设置页。
 *
 * 本文件提供**分部 G 的完整沙箱页**：在 dsh 里看沙箱、把插件注入到环境（并**热装载**进
 * 当前运行中的 dsh，无需重启）、移除、检查更新、收割环境、回收空间。
 *
 * 三条设计纪律
 * -----------
 *  1. **样式走 dsh 自己的令牌**（`--dsw-alias-*`，实测自 `dsh-web-frontend` 的产物 CSS），
 *     不写死颜色 —— 否则深浅色主题一切换就会露馅。每个取值都带兜底，令牌缺失也能看。
 *  2. **结论必须带"生效范围"**：注入的四种结局（已生效 / 需启动该环境 / 已挂载但未声明 /
 *     失败）用**不同措辞**显示。含糊成"成功"正是本项目一直在打的那类缺陷。
 *  3. **任何异常都不许把设置页弄白**：所有 fetch 都收敛成 `{ error }`，渲染层只吃状态。
 *
 * 为什么用 `settings.section`
 * -------------------------
 * 实测全 dsh 树里的 slot 名：`settings.section` **真实存在**（4 处官方注册/渲染），
 * 而本仓库旧插件用的 `workbench.sidebar.item` 与 `global.overlay` **全树 0 命中** ——
 * 那两块界面从来没有渲染过。
 *
 * React 从模块加载器的 `require` 拿（不 import），因此产物不含 React —— 浏览器侧只有一份。
 *
 * 本文件刻意写成 `.ts` + `createElement`（而不是 `.tsx`）：仓库根 `tsconfig.json` 的
 * include 只覆盖各包 `src` 下的 `.ts`，`.tsx` 不在根类型门内。
 *
 * @module @godsh/dsh/client
 */

/** 客户端插件名（Cordis 客户端约定，与宿主半同名）。 */
export const name = 'godsh'

/** 需要 slots。locale 是**可选**的（拿不到就退回内置中文文案），故不写进 inject。 */
export const inject = ['slots']

/** 路由前缀（必须与宿主半 `routes.ts` 的 `GODSH_API_PREFIX` 一致）。 */
const API_PREFIX = '/api/dsh-godsh'
/** 沙箱前缀（必须与宿主半 `sandbox/routes.ts` 的 `SANDBOX_API_PREFIX` 一致）。 */
const SANDBOX_PREFIX = `${API_PREFIX}/sandbox`

/** 模块加载器注入的 `require`（构建产物是 CJS，由 factory 提供）。 */
declare const require: (id: string) => unknown

/** 本文件用到的 React 面（自己声明，避免为一块面板引入 @types/react 依赖）。 */
interface ReactElementLike {
  type: unknown
  props: unknown
  key: unknown
}
type ReactNodeLike = ReactElementLike | string | number | null | undefined | boolean
interface CSSProps {
  [key: string]: string | number | undefined
}
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: ReactNodeLike[]): ReactElementLike
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}

// ---------------------------------------------------------------- 视图类型

/** 沙箱条目（与宿主半 `SandboxEntryView` 对齐）。 */
interface SandboxEntry {
  id: string
  name: string
  version: string
  kind: string
  parentId?: string
  childOrigin?: 'standalone' | 'shared-copy'
  isChild: boolean
  originKind: string
  originLabel: string
  updatable: boolean
  hasUpdate: boolean
  latestVersion?: string
  installedProfiles: string[]
  sizeBytes?: number
  securityLevel?: string
}

/** 沙箱状态（与宿主半 `SandboxStatus` 对齐）。 */
interface SandboxStatusView {
  dataDir: string
  dataDirFrom: string
  dataDirReason: string
  storeDir: string
  indexExists: boolean
  ownProfile: string | null
  profilesDir: string | null
  count: number
  error?: string
}

/** 注入结果的四阶段（与宿主半 `InjectPhases` 对齐）。 */
interface InjectPhases {
  preflight: { ok: boolean; message: string }
  physical: { ok: boolean; message: string; deployed: string[]; companions: string[] }
  declared: { ok: boolean; message: string; patchPath?: string }
  hotMounted: { attempted: boolean; ok: boolean; message: string; results: { target: string; ok: boolean; code: string }[] }
}

/** 注入结果（与宿主半 `InjectResult` 对齐）。 */
interface InjectResult {
  ok: boolean
  pluginId: string
  profile: string
  effectiveness: 'live' | 'needs-profile-start' | 'registered-only' | 'failed'
  message: string
  phases: InjectPhases
}

/** 面板状态。 */
interface PanelState {
  loading: boolean
  busy: string | null
  error: string | null
  status: SandboxStatusView | null
  entries: SandboxEntry[]
  notice: string | null
  inject: InjectResult | null
  filter: string
  /**
   * 正在等待二次确认的移除目标 id。
   *
   * 为什么不用 `window.confirm`：本面板跑在**宿主的应用壳**里（dsh 的 Web GUI，
   * 也可能是 Tauri/WebView），原生 confirm 在部分宿主里被禁用或样式不可控；
   * 而 godsh 自己在早期就把 19 处 `window.confirm` 换成了自研确认框。
   * 这里采用更轻的**两步确认**：点「移除」变成「确认移除」，再点一次才执行。
   * 顺带一个好处：不引入任何全局对象依赖，类型门也不必为 DOM 库开口子。
   */
  confirmingRemove: string | null
}

// ---------------------------------------------------------------- 文案

const ZH = {
  sectionLabel: 'godsh 插件沙箱',
  title: 'godsh 插件沙箱',
  subtitle: '在 dsh 内直接管理沙箱：注入即热装载（不重启进程）',
  refresh: '刷新',
  checkUpdates: '检查更新',
  harvest: '收割环境',
  gc: '回收空间',
  inject: '注入并热装载',
  update: '更新',
  remove: '移除',
  loading: '正在读取沙箱…',
  empty: '沙箱是空的。可以点「收割环境」把各环境已装的插件反向纳管进来。',
  filterPlaceholder: '按插件名过滤…',
  targetProfile: '目标环境',
  dataDir: '数据目录',
  ownProfile: '当前运行环境',
  indexExists: '索引',
  notIndexed: '尚未建立（空沙箱）',
  indexed: '已建立',
  noProfile: '未知',
  notUpdatable: '不可自动更新',
  child: '子依赖',
  sharedCopy: '按父隔离副本',
  orphan: '孤儿：父已缺失',
  confirmRemove: '确定从沙箱移除',
  andChildren: '（会连带其子依赖）',
  effectivenessLive: '已生效：插件已进入当前运行中的 dsh，未重启进程',
  effectivenessNeedsStart: '已注入并写入补丁层；该环境下次启动时生效',
  effectivenessRegistered: '已挂载并写入补丁层，但热装载未完全成功；下次启动必然生效',
  effectivenessFailed: '注入失败',
  phasePreflight: '① 预检',
  phasePhysical: '② 物理挂载与声明',
  phaseDeclared: '③ 写补丁层',
  phaseHot: '④ 热装载',
  profiles: '已注入环境',
  none: '无',
} as const

// ---------------------------------------------------------------- 样式（全部走 dsh 令牌）

const S: Record<string, CSSProps> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--dsw-font-family, inherit)' },
  header: { display: 'flex', flexDirection: 'column', gap: 4 },
  title: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
  subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
    borderRadius: 8,
    padding: '10px 12px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  mono: { fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)', fontSize: 11, wordBreak: 'break-all' },
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
  small: { fontSize: 11, color: 'var(--dsw-alias-label-caption, #999)' },
  badge: {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3))',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    whiteSpace: 'nowrap',
  },
  badgeOk: {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    color: 'var(--dsw-alias-state-success-primary, #2e7d32)',
    border: '1px solid var(--dsw-alias-state-success-primary, #2e7d32)',
    whiteSpace: 'nowrap',
  },
  badgeWarn: {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    color: 'var(--dsw-alias-state-warn-primary, #b26a00)',
    border: '1px solid var(--dsw-alias-state-warn-primary, #b26a00)',
    whiteSpace: 'nowrap',
  },
  badgeErr: {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    color: 'var(--dsw-alias-state-error-primary, #c62828)',
    border: '1px solid var(--dsw-alias-state-error-primary, #c62828)',
    whiteSpace: 'nowrap',
  },
  btn: {
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    background: 'var(--dsw-alias-button-ghost-active-fill, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  btnPrimary: {
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-button-primary-fill, #4f46e5)',
    background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
    color: 'var(--dsw-alias-label-primary-inverted, #fff)',
  },
  input: {
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
  },
  itemChild: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '6px 10px 6px 26px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15))',
    background: 'var(--dsw-alias-bg-layer-3, transparent)',
  },
  pre: {
    margin: 0,
    fontSize: 11,
    maxHeight: 160,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    background: 'var(--dsw-alias-markdown-code-block, rgba(128,128,128,.08))',
    padding: 8,
    borderRadius: 6,
  },
}

// ---------------------------------------------------------------- 工具

/** 人类可读体积。 */
function human(bytes?: number): string {
  if (bytes === undefined || bytes <= 0) return '—'
  const mb = bytes / 1048576
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

/**
 * 统一的 JSON 请求。
 *
 * 任何失败（网络、非 JSON）都收敛成 `{ ok:false, error }` —— 抛出会让设置页整块空白，
 * 那是"插件把宿主界面弄坏"的典型方式。202/409 也视为"有结论"，交由调用方按
 * `effectiveness` 显示。
 */
async function call(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ ok: boolean; data: Record<string, unknown> | null; error: string | null }> {
  try {
    const res = await fetch(`${SANDBOX_PREFIX}${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = null
    }
    if (data === null) return { ok: false, data: null, error: `响应不是 JSON（HTTP ${String(res.status)}）` }
    return { ok: res.ok || res.status === 202 || res.status === 409, data, error: null }
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 注入结论 → 一行带语义的显示文本。 */
function effectivenessText(r: InjectResult): string {
  switch (r.effectiveness) {
    case 'live':
      return `${ZH.effectivenessLive} — ${r.message}`
    case 'needs-profile-start':
      return `${ZH.effectivenessNeedsStart} — ${r.message}`
    case 'registered-only':
      return `${ZH.effectivenessRegistered} — ${r.message}`
    case 'failed':
      return `${ZH.effectivenessFailed} — ${r.message}`
  }
}

/** 注入结论 → 徽章样式。 */
function effectivenessStyle(r: InjectResult): CSSProps {
  if (r.effectiveness === 'live') return S.badgeOk ?? {}
  if (r.effectiveness === 'failed') return S.badgeErr ?? {}
  return S.badgeWarn ?? {}
}

// ---------------------------------------------------------------- 面板组件

/** godsh 沙箱面板（设置页里的一个 section）。 */
function SandboxPanel(props: { t?: (key: keyof typeof ZH) => string }): ReactElementLike {
  const React = require('react') as ReactLike
  const h = React.createElement
  const t = (key: keyof typeof ZH): string => props.t?.(key) ?? ZH[key]

  const [state, setState] = React.useState<PanelState>({
    loading: true,
    busy: null,
    error: null,
    status: null,
    entries: [],
    notice: null,
    inject: null,
    filter: '',
    confirmingRemove: null,
  })
  const [target, setTarget] = React.useState<string>('')

  const patch = (next: Partial<PanelState>): void => setState((prev) => ({ ...prev, ...next }))

  const reload = (): void => {
    patch({ loading: true })
    void call('/list', 'GET').then(({ ok, data, error }) => {
      if (!ok || data === null) return patch({ loading: false, error: error ?? '读取沙箱失败' })
      const entries = Array.isArray(data.entries) ? (data.entries as SandboxEntry[]) : []
      const status = (data.status ?? null) as SandboxStatusView | null
      patch({ loading: false, error: status?.error ?? null, entries, status })
      const own = status?.ownProfile
      if (typeof own === 'string' && own !== '') setTarget((prev) => (prev === '' ? own : prev))
    })
  }

  React.useEffect(() => {
    reload()
  }, [])

  /** 包一层"忙碌 + 通知"，避免每个动作重复写同样的十行。 */
  const run = (
    key: string,
    notice: string,
    fn: () => Promise<{ ok: boolean; data: Record<string, unknown> | null; error: string | null }>,
  ): void => {
    patch({ busy: key, notice: null })
    void fn().then(({ ok, data, error }) => {
      const fail = error ?? (typeof data?.error === 'string' ? data.error : null)
      patch({ busy: null, notice: ok && fail === null ? notice : `${notice} —— ${fail ?? '未完成'}` })
      reload()
    })
  }

  const doInject = (entry: SandboxEntry): void => {
    patch({ busy: `inject:${entry.id}`, notice: null, inject: null })
    void call('/inject', 'POST', { pluginId: entry.id, ...(target === '' ? {} : { profile: target }) }).then(({ data, error }) => {
      if (data === null) return patch({ busy: null, error: error ?? '注入失败：没有返回结论' })
      patch({ busy: null, inject: data as unknown as InjectResult })
      reload()
    })
  }

  /**
   * 移除 —— 两步确认。
   *
   * 第一次点击把该行切到"确认移除"，第二次才真的执行；任何其它操作会清掉待确认状态。
   * 这样既不依赖宿主可能禁用的原生 confirm，也不会让人误删（子依赖会随父一起走）。
   */
  const doRemove = (entry: SandboxEntry): void => {
    if (state.confirmingRemove !== entry.id) {
      patch({ confirmingRemove: entry.id, notice: null })
      return
    }
    patch({ confirmingRemove: null })
    run(`remove:${entry.id}`, `已移除 ${entry.name}`, () => call('/remove', 'POST', { ids: [entry.id] }))
  }

  const doUpdate = (entry: SandboxEntry): void => {
    run(`update:${entry.id}`, `已更新 ${entry.name}`, () => call('/update', 'POST', { id: entry.id }))
  }

  // ---------------------------------------------------------------- 渲染

  const children: ReactNodeLike[] = []
  const status = state.status

  children.push(
    h('div', { key: 'header', style: S.header },
      h('div', { style: S.title }, t('title')),
      h('div', { style: S.subtitle }, t('subtitle')),
    ),
  )

  if (status !== null) {
    children.push(
      h('div', { key: 'status', style: S.card },
        h('div', { key: 'd', style: S.row },
          h('span', { style: S.muted }, `${t('dataDir')}：`),
          h('span', { style: S.mono }, status.dataDir),
          h('span', { style: S.small }, `（${status.dataDirReason}）`),
        ),
        h('div', { key: 'p', style: S.row },
          h('span', { style: S.muted }, `${t('ownProfile')}：`),
          h('span', { style: S.badge }, status.ownProfile ?? t('noProfile')),
          h('span', { style: S.muted }, `${t('indexExists')}：`),
          h('span', { style: S.badge }, status.indexExists ? t('indexed') : t('notIndexed')),
          h('span', { style: S.muted }, `条目：${String(status.count)}`),
        ),
      ),
    )
  }

  if (state.error !== null) {
    children.push(h('div', { key: 'err', style: S.card }, h('div', { style: S.badgeErr }, state.error)))
  }

  children.push(
    h('div', { key: 'tools', style: S.row },
      h('button', { key: 'r', style: S.btn, disabled: state.loading || state.busy !== null, onClick: reload }, t('refresh')),
      h('button', {
        key: 'c',
        style: S.btn,
        disabled: state.busy !== null,
        onClick: () => run('check', '已完成更新检查', () => call('/check-updates', 'POST')),
      }, t('checkUpdates')),
      h('button', {
        key: 'h',
        style: S.btn,
        disabled: state.busy !== null,
        onClick: () => run('harvest', '已收割环境', () => call('/harvest', 'POST')),
      }, t('harvest')),
      h('button', {
        key: 'g',
        style: S.btn,
        disabled: state.busy !== null,
        onClick: () => run('gc', '已回收未被链接的池目录', () => call('/gc', 'POST')),
      }, t('gc')),
      h('span', { key: 'sp', style: S.spacer }),
      h('span', { key: 'b', style: S.small }, state.busy === null ? '' : `进行中：${state.busy}`),
    ),
  )

  children.push(
    h('div', { key: 'target', style: S.row },
      h('span', { style: S.muted }, `${t('targetProfile')}：`),
      h('input', {
        style: S.input,
        value: target,
        placeholder: status?.ownProfile ?? 'profile 名',
        onChange: (e: { target: { value: string } }) => setTarget(e.target.value),
      }),
      h('span', { style: S.small },
        typeof status?.ownProfile === 'string' && status.ownProfile !== ''
          ? `填「${status.ownProfile}」= 注入当前运行环境并热装载；填其它环境 = 该环境下次启动时生效`
          : '本进程的 profile 名未知，请显式填写目标环境',
      ),
    ),
  )

  if (state.notice !== null) {
    children.push(h('div', { key: 'notice', style: S.card }, h('div', { style: S.muted }, state.notice)))
  }

  if (state.inject !== null) {
    const r = state.inject
    children.push(
      h('div', { key: 'inject', style: S.card },
        h('div', { key: 'sum', style: S.row },
          h('span', { style: effectivenessStyle(r) }, r.effectiveness),
          h('span', { style: S.muted }, effectivenessText(r)),
        ),
        h('pre', { key: 'phases', style: S.pre }, [
          `${t('phasePreflight')}: ${r.phases.preflight.ok ? 'ok' : 'fail'} — ${r.phases.preflight.message}`,
          `${t('phasePhysical')}: ${r.phases.physical.ok ? 'ok' : 'fail'} — ${r.phases.physical.message}`,
          `${t('phaseDeclared')}: ${r.phases.declared.ok ? 'ok' : 'fail'} — ${r.phases.declared.message}`,
          `${t('phaseHot')}: ${r.phases.hotMounted.attempted ? (r.phases.hotMounted.ok ? 'ok' : 'fail') : 'skip'} — ${r.phases.hotMounted.message}`,
        ].join('\n')),
      ),
    )
  }

  children.push(
    h('div', { key: 'filter', style: S.row },
      h('input', {
        style: { ...S.input, flex: 1 },
        value: state.filter,
        placeholder: t('filterPlaceholder'),
        onChange: (e: { target: { value: string } }) => patch({ filter: e.target.value }),
      }),
    ),
  )

  if (state.loading) {
    children.push(h('div', { key: 'loading', style: S.card }, h('div', { style: S.muted }, t('loading'))))
  } else if (state.entries.length === 0) {
    children.push(h('div', { key: 'empty', style: S.card }, h('div', { style: S.muted }, t('empty'))))
  } else {
    const kw = state.filter.trim().toLowerCase()
    const matched = kw === '' ? state.entries : state.entries.filter((e) => e.name.toLowerCase().includes(kw))
    const ids = new Set(matched.map((e) => e.id))
    const roots = matched.filter((e) => !e.isChild)
    const childCount = new Map<string, number>()
    for (const e of matched) {
      if (e.parentId !== undefined) childCount.set(e.parentId, (childCount.get(e.parentId) ?? 0) + 1)
    }
    // 子行保留 parentId 以便折叠；父已被过滤掉/缺失时按"孤儿"显示（不隐藏，否则用户看不到它）
    const orphans = matched.filter((e) => e.isChild && (e.parentId === undefined || !ids.has(e.parentId)))

    const renderRow = (e: SandboxEntry, indent: boolean, missingParent: boolean): ReactElementLike => {
      const badges: ReactNodeLike[] = [h('span', { key: 'origin', style: S.badge }, e.originLabel)]
      if (e.childOrigin === 'shared-copy') badges.push(h('span', { key: 'sc', style: S.badge }, t('sharedCopy')))
      if (e.hasUpdate && e.latestVersion !== undefined) {
        badges.push(h('span', { key: 'upd', style: S.badgeWarn }, `可更新 → ${e.latestVersion}`))
      } else if (!e.updatable) {
        badges.push(h('span', { key: 'noupd', style: S.badge }, t('notUpdatable')))
      }
      if (e.isChild) badges.push(h('span', { key: 'child', style: S.badge }, missingParent ? t('orphan') : t('child')))
      const kids = childCount.get(e.id) ?? 0
      if (kids > 0) badges.push(h('span', { key: 'kids', style: S.badge }, `含 ${String(kids)} 个子插件`))

      const actions: ReactNodeLike[] = []
      if (!e.isChild) {
        actions.push(h('button', {
          key: 'inject',
          style: S.btnPrimary,
          disabled: state.busy !== null,
          onClick: () => doInject(e),
        }, state.busy === `inject:${e.id}` ? '注入中…' : t('inject')))
      }
      if (e.updatable) {
        actions.push(h('button', {
          key: 'update',
          style: S.btn,
          disabled: state.busy !== null,
          onClick: () => doUpdate(e),
        }, state.busy === `update:${e.id}` ? '更新中…' : t('update')))
      }
      const confirming = state.confirmingRemove === e.id
      actions.push(h('button', {
        key: 'remove',
        // 待确认时用危险色 + 「确认移除」文案，让"再点一次就真删"这件事一眼可见
        style: confirming ? S.badgeErr : S.btn,
        disabled: state.busy !== null,
        onClick: () => doRemove(e),
      }, state.busy === `remove:${e.id}` ? '移除中…' : confirming ? '确认移除？' : t('remove')))

      return h('div', { key: e.id, style: indent ? S.itemChild : S.item },
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, fontSize: 12 } }, `${e.name}@${e.version}`),
          ...badges,
          h('span', { style: S.spacer }),
          h('span', { style: S.small },
            `${t('profiles')}：${e.installedProfiles.length === 0 ? t('none') : e.installedProfiles.join(', ')} · ${human(e.sizeBytes)}`),
          ...actions,
        ),
      )
    }

    for (const root of roots) {
      children.push(renderRow(root, false, false))
      for (const child of matched.filter((e) => e.parentId === root.id)) {
        children.push(renderRow(child, true, false))
      }
    }
    for (const orphan of orphans) children.push(renderRow(orphan, true, true))
  }

  return h('div', { className: 'godsh-sandbox-panel', style: S.root }, ...children)
}

// ---------------------------------------------------------------- 客户端入口

/** 客户端上下文（只声明用到的成员）。 */
export interface GodshClientContext {
  slots?: {
    inject(slot: string, factory: () => unknown): void
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
        SandboxPanel(t === undefined ? props : { ...props, t })
      )
    )
  } catch (error) {
    ctx.logger?.warn(`[godsh] 注册 settings.section 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
