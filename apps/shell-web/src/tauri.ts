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

/**
 * 打开 dsh Web UI：
 * - Tauri 桌面端：新建独立原生 WebView 窗口加载 URL（体验与 DSH Desktop 一致）
 * - Web 模式：新标签页打开
 */
export async function openDshUrl(url: string, title?: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke('open_dsh_window', { url, title: title ?? 'dsh' })
      return
    } catch (e) {
      console.warn('open_dsh_window 失败，回退浏览器', e)
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 用系统默认浏览器打开 URL（Tauri 下调用 open_external；Web 下新标签页）。 */
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
