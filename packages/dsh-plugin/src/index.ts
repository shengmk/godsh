import type { CordisContext } from './types.js'
import { GodshService, type GodshServiceOptions } from './service.js'

export * from './types.js'
export * from './service.js'
export * from './patch-manager.js'
export * from './backup-manager.js'
export * from './memory-engine.js'
export * from './workflow-runner.js'

/**
 * DSH 插件标准入口：apply(ctx, options)
 */
export function apply(ctx: CordisContext, options?: Partial<GodshServiceOptions>) {
  const home = process.env.DSH_HOME || (process.env.USERPROFILE ? `${process.env.USERPROFILE}/.dsh` : './.dsh')
  const profilesDir = options?.profilesDir || `${home}/profiles`

  const godsh = new GodshService(ctx, {
    profilesDir,
    ...options,
  })

  // 挂载至上下文
  ctx.provide('godsh')
  ctx['godsh'] = godsh
}
