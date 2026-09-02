import { GodshDrawer } from './drawer.js'
import { GodshTaskHud } from './hud.js'

export * from './drawer.js'
export * from './hud.js'

export interface ClientSlotRegistry {
  register(slotName: string, componentOrFactory: () => unknown): void
}

export interface DshClientContext {
  slots: ClientSlotRegistry
  [key: string]: unknown
}

/**
 * 客户端 UI 槽位挂载入口：将 Drawer 与 HUD 注入 DSH 内部
 */
export function apply(ctx: DshClientContext) {
  if (!ctx.slots) return

  const drawer = new GodshDrawer(ctx)
  const hud = new GodshTaskHud()

  // 1. 挂载到 DSH 主工作台左侧侧边栏图标
  ctx.slots.register('workbench.sidebar.item', () => ({
    id: 'godsh-launcher',
    title: 'godsh 环境与工作流',
    icon: '⚡',
    render: () => drawer.renderHtml(),
  }))

  // 2. 挂载到 DSH 右下角常驻任务中心 HUD
  ctx.slots.register('global.overlay', () => ({
    id: 'godsh-task-hud',
    render: () => hud.renderHtml(),
  }))
}
