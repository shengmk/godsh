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
 * 在独立窗口中打开 dsh Web UI（Tauri 桌面端）。
 * 失败时抛错，由调用方回退到系统浏览器。
 */
async function openWindow(url: string, title: string): Promise<void> {
  await tauriInvoke('open_dsh_window', { url, title })
}

/**
 * 用系统默认浏览器打开 URL（Tauri 下调用 open_external → cmd /c start，绝对可靠；
 * Web 下新标签页）。
 */
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
 * 打开 dsh Web UI（推荐入口）：
 * - Tauri 桌面端：优先新建独立 WebView 窗口；失败自动回退系统浏览器
 * - Web 模式：新标签页打开
 * 返回实际使用的打开方式，供调用方提示。
 */
export async function openDshUrl(url: string, title?: string): Promise<'window' | 'browser'> {
  const t = title || 'dsh'
  if (isTauri()) {
    try {
      await openWindow(url, t)
      return 'window'
    } catch (e) {
      console.warn('open_dsh_window 失败，回退系统浏览器', e)
      await openExternal(url)
      return 'browser'
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return 'browser'
}
