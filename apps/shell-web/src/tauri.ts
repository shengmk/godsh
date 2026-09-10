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

// 非 Tauri（Web/浏览器开发态）基址：同源 /api（由 Vite dev proxy 转发），可由 VITE_API_BASE 覆盖。
const FALLBACK_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

// Tauri 桌面端：后端端口由 Rust 动态探测（4780 被占则顺延），
// 必须运行时查询实际端口，避免前后端端口错位导致「连接被拒绝」。
let apiBasePromise: Promise<string> | null = null

/**
 * 解析后端 API 基址（api.ts 与桌面端回退请求共用同一套解析逻辑）。
 * 打包后的 Tauri 构建里**不能**用相对路径 /api（没有 dev proxy），必须走真实端口。
 */
export function resolveApiBase(): Promise<string> {
  if (isTauri()) {
    apiBasePromise ??= tauriInvoke('get_server_port')
      .then((port) => `http://127.0.0.1:${port as number}/api`)
      .catch(() => FALLBACK_API_BASE)
    return apiBasePromise
  }
  return Promise.resolve(FALLBACK_API_BASE)
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
 * 打开 dsh web 界面（默认入口）：
 * godsh 已用（自定义）端口启动了 dsh web 服务，直接用浏览器「网址应用化」
 * （--app=URL 独立应用窗口，无地址栏，浏览器渲染不白屏）打开该端口，
 * 与端口自定义天然一致、零冲突。
 */
export async function openDshWeb(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke('open_app_window', { url })
      return
    } catch (e) {
      console.warn('open_app_window 失败，回退普通浏览器', e)
    }
  }
  await openExternal(url)
}

/**
 * 用独立的 DSH Desktop 软件打开指定 profile（备选入口，右键菜单）。
 * 注意：DSH Desktop 常驻运行时（单实例锁）新进程的环境变量不生效，
 * 此方式适合 DSH Desktop 未运行（冷启动）的场景。
 *
 * url：调用方已经拿到的 dsh web 认证地址（含 token）；
 * 旧实现固定传 ''，Rust 侧 url.parse('') 直接失败，这里改为透传真实地址。
 * 返回 true 表示已尝试启动。
 */
export async function openDshDesktop(profile: string, url?: string | null): Promise<boolean> {
  const target = url ?? ''
  if (isTauri()) {
    try {
      await tauriInvoke('open_dsh_profile', { profile, url: target })
      return true
    } catch (e) {
      console.warn('open_dsh_profile 失败，尝试通过后端 API 唤醒', e)
    }
  }
  try {
    // 走 api 基址解析：相对 /api 只在 Vite dev（有代理）下有效，
    // 打包后的 Tauri 构建 API 在 http://127.0.0.1:<运行时端口>/api。
    const base = await resolveApiBase()
    const res = await fetch(`${base}/dsh/open-desktop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })
    return res.ok
  } catch (e) {
    console.warn('open-desktop API 调用失败', e)
    return false
  }
}
