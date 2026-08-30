/**
 * Tauri 桌面端能力封装。
 *
 * 注意：不依赖 `@tauri-apps/api` npm 包（registry 网络受限无法安装），
 * 直接使用 Tauri 2 注入的全局 `window.__TAURI_INTERNALS__.invoke`。
 * Web 模式（浏览器）下自动回退到 window.open。
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    }
  }
}

/** 当前是否运行在 Tauri 桌面端。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

/** 调用 Tauri Rust command；非 Tauri 环境抛错（调用方应回退）。 */
export async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!window.__TAURI_INTERNALS__) throw new Error('不在 Tauri 环境')
  return window.__TAURI_INTERNALS__.invoke(cmd, args ?? {})
}

/** 用系统默认浏览器打开 URL（Tauri 下调用 open_external → cmd /c start，绝对可靠；Web 下新标签页）。 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke('open_external', { url })
      return
    } catch (e) {
      console.warn('open_external 失败，回退 window.open', e)
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 用系统浏览器打开 dsh web 界面（默认入口）：
 * godsh 已用（自定义）端口启动了 dsh web 服务，浏览器直接访问该端口即可，
 * 与端口自定义天然一致、零冲突；DSH Desktop 常驻运行时环境变量无效，
 * 浏览器是最可靠的打开方式。
 */
export async function openDshWeb(url: string): Promise<void> {
  await openExternal(url)
}

/**
 * 用独立的 DSH Desktop 软件打开指定 profile（备选入口，右键菜单）。
 * 注意：DSH Desktop 常驻运行时（单实例锁）新进程的环境变量不生效，
 * 此方式适合 DSH Desktop 未运行（冷启动）的场景。
 * 返回 true 表示已尝试启动。
 */
export async function openDshDesktop(profile: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await tauriInvoke('open_dsh_profile', { profile, url: '' })
      return true
    } catch (e) {
      console.warn('open_dsh_profile 失败', e)
      return false
    }
  }
  return false
}