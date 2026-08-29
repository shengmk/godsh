import { run, type RunResult } from '@godsh/core'

export type InstallAction = 'add' | 'remove' | 'update'

/** 安装类命令默认超时（dsh plugin 底层 pnpm 可能较慢；超时 kill 并返回可读错误）。 */
export const PLUGIN_ACTION_TIMEOUT_MS = 180_000

/** 常见本地代理端口（Clash/v2rayN/系统代理等默认监听）。 */
const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 10808, 1080, 12450, 8888]

/**
 * 探测可用的本地 HTTP 代理（同步阻塞短超时）。找不到返回 null。
 * 目的：pnpm 安装 github:/http-tgz 源插件时走代理，否则 GitHub 443 被墙导致下载失败。
 */
export function detectLocalProxy(): string | null {
  // 1) 显式环境变量优先
  const envProxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy
  if (envProxy) return envProxy
  // 2) 同步探测常见本地代理端口
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  for (const port of LOCAL_PROXY_PORTS) {
    try {
      // 用 netstat 检查端口是否监听（避免真正建立连接的开销与误判）
      const out = execSync(`netstat -ano -p tcp | findstr "127.0.0.1:${port} LISTENING"`, {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (out.includes('LISTENING')) return `http://127.0.0.1:${port}`
    } catch {
      /* 端口未监听或 netstat 不可用，继续 */
    }
  }
  return null
}

/**
 * 封装 `dsh plugin --profile <name> <action> <pkg>`，
 * 底层由 dsh 转发给 profile 目录中的 pnpm，并自动 reconcile bundles。
 * 默认带超时（避免无限挂起），可通过 timeoutMs 覆盖。
 * 自动注入本地代理环境变量，让 pnpm 能下载 github:/http-tgz 源。
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
  return run('dsh', ['plugin', '--profile', profile, action, pkg], { timeoutMs, env })
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
