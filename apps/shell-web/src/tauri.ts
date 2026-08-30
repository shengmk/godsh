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
 * 打开 dsh 环境（推荐入口）：
 * - Tauri 桌面端：优先启动独立的 DSH Desktop 软件打开该 profile；
 *   未安装 DSH Desktop 时自动改用系统浏览器打开 web URL。
 * - Web 模式：新标签页打开。
 * 返回实际使用的打开方式：desktop | browser。
 */
export async function openDshUrl(profile: string, url: string): Promise<'desktop' | 'browser'> {
  if (isTauri()) {
    try {
      const mode = (await tauriInvoke('open_dsh_profile', { profile, url })) as string
      return mode === 'desktop' ? 'desktop' : 'browser'
    } catch (e) {
      console.warn('open_dsh_profile 失败，回退浏览器', e)
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return 'browser'
}
