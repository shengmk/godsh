/**
 * godsh 插件用到的**最小宿主上下文契约**。
 *
 * 为什么在这里自己声明、而不是 `import type` dsh 的官方包：
 *  - 本包**零运行时依赖**。宿主半由 dsh 进程装载，所有服务都是 dsh 通过 Cordis 注入的，
 *    我们只在运行时经 `ctx.get(...)` 惰取；一旦为了类型去 peer-depend 那些官方包，
 *    安装时就要解析它们（离线/镜像不一致时会失败），而收益只是类型好看。
 *  - 这里刻意**只声明我们真正用到的成员**，且全部按「可能存在」建模 —— 因为不同 profile
 *    装载的服务集合不同（headless 没有 webServer、sdk 没有 settings）。
 *    把可选服务写进 `inject` 会让插件在缺该服务的 profile 里干脆装不上，这是本项目
 *    在 `@godsh/dsh-plugin` 上踩过的坑。
 *
 * 类型纪律：不用 `any`，不用 `@ts-ignore`；外部形状一律经 `unknown` + 收窄函数进入。
 *
 * @module @godsh/dsh/host-types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** dsh web 服务器的路由种类（来自 `@deepseek-ai/dsh-host-webserver` 的 `WebRouteKind`）。 */
export type WebRouteKind = 'exact' | 'prefix'

/** 一条 dsh web 路由。`handler` 独占整条响应生命周期（可以保持连接，例如 SSE）。 */
export interface WebRoute {
  kind: WebRouteKind
  /** 绝对路径，结尾不带斜杠。 */
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** dsh web 服务器服务的最小面（`ctx.get('webServer')`）。 */
export interface WebServerLike {
  register(route: WebRoute): () => void
}

/** Cordis loader 的一个条目（`ctx.loader.entries()` 的元素）。 */
export interface LoaderEntryLike {
  options: {
    /** 包名（客户端模块图按它索引；patch 行 id 是另一个字段）。 */
    name?: string
    id?: string
    config?: unknown
    disabled?: boolean
  }
  fiber?: { dispose(): Promise<void> } | null
  update(patch: { config?: unknown; disabled?: boolean }): Promise<void>
  dispose(): Promise<void>
}

/** Cordis loader 服务的最小面。 */
export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  create(options: { id?: string; name: string; config?: unknown; disabled?: boolean }): Promise<void>
}

/** Cordis HMR 服务的最小面（`@deepseek-ai/cordis-plugin-hmr`）。 */
export interface HmrLike {
  registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>
}

/** godsh 宿主半用到的全部宿主能力，全部可选。 */
export interface HostContext {
  loader?: LoaderLike
  webServer?: WebServerLike
  logger?: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  effect?(callback: () => (() => void) | void, name?: string): void
  /**
   * Cordis 的「等某个服务出现再执行」入口。
   *
   * 我们**不用**它做硬依赖（那会阻止插件装载），只在需要 webServer 时用它做
   * 「服务就位后再注册路由」的延迟挂载。
   */
  inject?(names: string[], callback: (ctx: HostContext) => void): void
  get(name: string): unknown
  provide(name: string, value: unknown): void
}

/** 把一个 `unknown` 收窄成具备某个方法的对象；不具备时返回 `null`（绝不抛）。 */
export function asObjectWith<T extends string>(
  value: unknown,
  method: T
): (Record<T, (...args: never[]) => unknown> & Record<string, unknown>) | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  return typeof record[method] === 'function'
    ? (record as Record<T, (...args: never[]) => unknown> & Record<string, unknown>)
    : null
}
