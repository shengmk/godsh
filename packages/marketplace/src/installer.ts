import { run, type RunResult } from '@godsh/core'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type InstallAction = 'add' | 'remove' | 'update'

/** 安装类命令默认超时（dsh plugin 底层 pnpm 可能较慢；超时 kill 并返回可读错误）。 */
export const PLUGIN_ACTION_TIMEOUT_MS = 180_000

/** 常见本地代理端口（Clash/v2rayN/系统代理等默认监听）。 */
const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 10808, 1080, 12450, 8888]

/**
 * 探测可用的本地 HTTP 代理（同步阻塞短超时）。找不到返回 null。
 * 目的：pnpm 安装 github:/http-tgz 源插件时走代理，否则 GitHub 443 被墙导致下载失败。
 * 注：仅当代理真的能访问目标时才返回（端口监听不代表可用，失效代理注入反而坏事）。
 */
export function detectLocalProxy(): string | null {
  // 1) 显式环境变量优先
  const envProxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy
  if (envProxy) return envProxy
  // 2) 同步探测常见本地代理端口，并要求能真正访问 github（避免失效代理）
  for (const port of LOCAL_PROXY_PORTS) {
    try {
      const out = execSync(`netstat -ano -p tcp | findstr "127.0.0.1:${port} LISTENING"`, {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (!out.includes('LISTENING')) continue
      // 连通性验证：走代理访问 github（失败则跳过该端口）
      try {
        execSync(
          `curl.exe -s -o NUL -w "%{http_code}" --max-time 6 -x http://127.0.0.1:${port} https://github.com 2>NUL | findstr /R "200 301 302 307"`,
          { timeout: 8000, windowsHide: true, stdio: 'ignore' },
        )
        return `http://127.0.0.1:${port}`
      } catch {
        /* 该端口无法访问 github，试下一个 */
      }
    } catch {
      /* 继续 */
    }
  }
  return null
}

/**
 * 封装 `dsh plugin --profile <name> <action> <pkg>`，
 * 底层由 dsh 转发给 profile 目录中的 pnpm，并自动 reconcile bundles。
 * 默认带超时（避免无限挂起），可通过 timeoutMs 覆盖。
 * 自动注入本地代理环境变量 + 统一 pnpm store-dir（防止多版本 pnpm 的 store 冲突）。
 */
export function pluginAction(profile: string, action: InstallAction, pkg: string, timeoutMs = PLUGIN_ACTION_TIMEOUT_MS): Promise<RunResult> {
  const proxy = detectLocalProxy()
  const env: Record<string, string> = {}
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
    env.npm_config_proxy = proxy
    env.npm_config_https_proxy = proxy
  }
  // 统一 pnpm store：固定到 %LOCALAPPDATA%\pnpm\store，避免 DSH 内置 pnpm(11.8)
  // 与 npm 全局 pnpm(11.22) 默认 store 位置不同导致 ERR_PNPM_UNEXPECTED_STORE。
  const storeDir = process.env.npm_config_store_dir || join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pnpm', 'store')
  env.npm_config_store_dir = storeDir
  // github: 源插件走 HTTPS（可代理/可直连），避免 pnpm 转成 git+ssh 因无 SSH key 失败
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'url.https://github.com/.insteadOf'
  env.GIT_CONFIG_VALUE_0 = 'git@github.com:'
  env.GIT_TERMINAL_PROMPT = '0'
  // dsh 命令解析：优先用已解析的 dsh 绝对路径（config dsh.bin 或 npm 全局），
  // 避免 PATH 异常时 "dsh is not recognized"。
  const dshCmd = resolveDshCommand()
  return run(dshCmd, ['plugin', '--profile', profile, action, pkg], { timeoutMs, env })
}

/** 解析 dsh 可执行文件路径（cmd shim 优先；找不到回退 'dsh' 让 PATH 解析）。 */
function resolveDshCommand(): string {
  if (process.env.DSH_BIN && process.env.DSH_BIN.trim()) return process.env.DSH_BIN
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd'),
    join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming', 'npm', 'dsh.cmd'),
  ]
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c
    } catch {
      /* 忽略 */
    }
  }
  return 'dsh'
}

export function installPlugin(profile: string, pkg: string): Promise<RunResult> {
  return pluginAction(profile, 'add', pkg)
}

export function removePlugin(profile: string, pkg: string): Promise<RunResult> {
  return pluginAction(profile, 'remove', pkg)
}

export function updatePlugin(profile: string, pkg: string): Promise<RunResult> {
  return pluginAction(profile, 'update', pkg)
}

/** 列出 Profile 已安装依赖（pnpm ls）。 */
export function listInstalled(profile: string): Promise<RunResult> {
  return run('dsh', ['plugin', '--profile', profile, 'ls'])
}

/**
 * 从市场索引插件的 `install` 字段解析真实安装参数。
 *
 * 市场索引字段：
 * - `name`：展示名（可能带 `#` 后缀，如 `dsh-trail#bundle`，不是可安装包名）
 * - `npm`：真实 npm 包名（存在时直接用它）
 * - `install`：权威安装命令文本，如
 *     `dsh plugin --profile web add github:user/repo`
 *     `dsh plugin --profile web add "https://...tgz"`
 *     `dsh plugin --profile web add @scope/pkg`
 *
 * 返回应传给 `dsh plugin add` 的参数；解析失败返回 null。
 */
export function resolveInstallArg(p: { name?: string; npm?: string; install?: string } | undefined): string | null {
  if (!p) return null
  // 1) npm 字段存在且非空 → 用 npm（真实包名）
  if (typeof p.npm === 'string' && p.npm.trim()) return p.npm.trim()
  // 2) 从 install 命令文本提取 add 之后的参数（可能带引号）
  if (typeof p.install === 'string' && p.install.trim()) {
    const m = /(?:^|\s)dsh\s+plugin\s+--profile\s+\S+\s+add\s+(.+)$/.exec(p.install.trim())
    if (m) {
      const arg = m[1]!.trim().replace(/^["']|["']$/g, '').trim()
      if (arg) return arg
    }
    // 兜底：install 里出现的 http(s)/github: 目标
    const urlMatch = /(https?:\/\/\S+|github:[^\s"']+)/.exec(p.install)
    if (urlMatch) return urlMatch[1]!.replace(/^["']|["']$/g, '')
  }
  // 3) 兜底：用 name（去掉 # 后缀）
  if (typeof p.name === 'string' && p.name.trim()) {
    return p.name.split('#')[0]!.trim() || null
  }
  return null
}
