import { run, type RunResult } from '@dsh-launcher/core'

export type InstallAction = 'add' | 'remove' | 'update'

/** 安装类命令默认超时（dsh plugin 底层 pnpm 可能较慢；超时 kill 并返回可读错误）。 */
export const PLUGIN_ACTION_TIMEOUT_MS = 180_000

/**
 * 封装 `dsh plugin --profile <name> <action> <pkg>`，
 * 底层由 dsh 转发给 profile 目录中的 pnpm，并自动 reconcile bundles。
 * 默认带超时（避免无限挂起），可通过 timeoutMs 覆盖。
 */
export function pluginAction(profile: string, action: InstallAction, pkg: string, timeoutMs = PLUGIN_ACTION_TIMEOUT_MS): Promise<RunResult> {
  return run('dsh', ['plugin', '--profile', profile, action, pkg], { timeoutMs })
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
