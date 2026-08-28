import { run, type RunResult } from '@dsh-launcher/core'

export type InstallAction = 'add' | 'remove' | 'update'

/**
 * 封装 `dsh plugin --profile <name> <action> <pkg>`，
 * 底层由 dsh 转发给 profile 目录中的 pnpm，并自动 reconcile bundles。
 */
export function pluginAction(profile: string, action: InstallAction, pkg: string): Promise<RunResult> {
  return run('dsh', ['plugin', '--profile', profile, action, pkg])
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
