/**
 * `@godsh/dsh` —— godsh 的 DSH 双面插件（宿主半）。
 *
 * 这个包让 godsh 从「dsh 之外的启动器」变成「dsh 之内的插件」：
 * 宿主半在 dsh 进程里提供**插件沙箱 / 瞬时注入 / 热装载**的服务与 HTTP 面，
 * 浏览器半在 dsh 的设置页里提供一个真实的 godsh 面板（见 `./client`）。
 *
 * 装载契约（三处必须同时正确，缺一装不进 profile）
 * ----------------------------------------------
 *   1. `package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"` —— 没有它，
 *      `dsh plugin add` 只把本包当普通依赖并在安装时告警；dsh 装载 profile 时对
 *      「列在 bundles 里但没有该字段的包」是**硬失败**（`dsh-app-boot` 的
 *      `loadProfileDirectory` 会抛 `declares no dsh.bundle in its package.json`）。
 *   2. `cordis.patch.yml` 里的 `- insert: [{ id, name }]`。
 *   3. **本文件导出的 `name` 必须逐字等于那份 patch 行的 `id`**（此处 `godsh`）。
 *      对不上就是一个永远不注入的僵尸行。
 *
 * 为什么 `inject` 是空的
 * ---------------------
 * 本插件**不**把任何服务写进 `inject`。宿主半只做两件事：注册一个服务、注册一组可选路由；
 * 两者都用 `ctx.get(...)` **惰取**。理由是本项目在 `@godsh/dsh-plugin` 上踩过的坑：
 * 一旦把可选服务（`webServer` 只在 web 系 profile 有）写进 `inject`，插件在 headless/sdk
 * profile 里会**干脆装不上**，而不是降级工作。装载得起来，永远比功能齐全更重要。
 *
 * 任何异常都不得穿出去：`apply()` 跑在用户的 dsh 进程里，抛出去可能把整棵树带崩。
 * 因此本文件对外只有「注册」与「降级」两种结局。
 *
 * @module @godsh/dsh
 */

import { join } from 'node:path'
import { HotBridge, type BridgeProbe, type HotEntryView, type HotResult } from './hot-bridge.js'
import { buildRoutes, registerRoutes, GODSH_API_PREFIX } from './routes.js'
import type { HostContext } from './host-types.js'

/** 插件名。**必须逐字等于 `cordis.patch.yml` 里那条 patch 行的 `id`。** */
export const name = 'godsh'

/**
 * 硬依赖：空。
 *
 * @see 文件头「为什么 inject 是空的」
 */
export const inject: string[] = []

/** 宿主半对外暴露的服务名（`ctx.get('godsh')` / 其它插件 inject 用）。 */
export const SERVICE_NAME = 'godsh'

/** `ctx.get('godsh')` 拿到的对象形状。 */
export interface GodshHostService {
  /** 热装载桥（分部 G/H 的执行体）。 */
  bridge: HotBridge
  /** 自检快照。 */
  probe(): BridgeProbe
  /** 运行树条目（只读）。 */
  entries(): HotEntryView[]
  /** 热装载一个包。 */
  mount(pkg: string, options?: { id?: string }): Promise<HotResult>
  /** 热卸载一个包。 */
  unmount(pkg: string): Promise<HotResult>
  /** 路由前缀（浏览器半必须用同一个）。 */
  apiPrefix: string
  /** 解析出的补丁文件路径（自检用）。 */
  patchFile: string
}

/**
 * 解析当前 profile 的补丁文件路径。
 *
 * `ctx.baseUrl` 在 dsh 里就是 profile 目录（`runProfile` 用它 boot 了一个位于该目录的
 * `cordis.yml` 作为 loader 的 include 根）。拿不到时退回 `process.cwd()` —— 此时路径只用于
 * 自检显示，不会成为任何写入目标，所以退化的后果只是提示文本不准。
 */
function resolvePatchFile(ctx: HostContext): string {
  const rawBase = (ctx as { baseUrl?: unknown }).baseUrl
  const base = typeof rawBase === 'string' && rawBase !== '' ? rawBase : process.cwd()
  return join(base, 'cordis.patch.yml')
}

/**
 * 插件入口。
 *
 * @param ctx - dsh 的 Cordis 宿主上下文（可能缺任意可选服务）。
 * @param _config - patch 行里传下来的 config；本插件当前不消费它。
 */
export function apply(ctx: HostContext, _config?: unknown): void {
  const patchFile = resolvePatchFile(ctx)
  const bridge = new HotBridge(ctx, patchFile)

  const service: GodshHostService = {
    bridge,
    probe: () => bridge.probe(),
    entries: () => bridge.list(),
    mount: (pkg, options) => bridge.mount(pkg, options),
    unmount: (pkg) => bridge.unmount(pkg),
    apiPrefix: GODSH_API_PREFIX,
    patchFile,
  }

  // 1) 注册服务：即使没有 webServer 也要可被其它插件/工具面消费
  try {
    ctx.provide(SERVICE_NAME, service)
  } catch (error) {
    ctx.logger?.warn(`[godsh] provide(${SERVICE_NAME}) 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 2) 注册路由：webServer 是**可选**服务
  //    优先用 Cordis 的延迟挂载（服务出现后再跑），拿不到该能力时退化为一次性尝试。
  const routes = buildRoutes(bridge)
  const registerNow = (host: HostContext): void => {
    const dispose = registerRoutes(host.get('webServer'), routes)
    // 把卸载器挂到插件 fiber 上，插件卸载时路由一起消失
    try {
      host.effect?.(() => dispose, 'godsh: api routes')
    } catch {
      /* effect 不可用时忽略：路由会随进程结束而消失 */
    }
    const present = host.get('webServer') !== undefined
    ctx.logger?.info(`[godsh] 宿主半已就绪（routes=${present ? String(routes.length) : '0（本 profile 无 webServer，已降级）'}，patch=${patchFile}）`)
  }

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerNow)
    else registerNow(ctx)
  } catch (error) {
    ctx.logger?.warn(`[godsh] 路由注册降级处理：${error instanceof Error ? error.message : String(error)}`)
  }
}

export { HotBridge, GODSH_API_PREFIX }
export type { BridgeProbe, HotEntryView, HotResult }
export type { RestartReason, HotBackend, HotResult as HotActionResult } from './hot-bridge.js'
export type { HostContext, WebRoute, WebServerLike } from './host-types.js'
