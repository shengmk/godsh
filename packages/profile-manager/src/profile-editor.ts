import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPatchChecked, serializePatchList } from './patch.js'
import { findProfile, invalidateProfileCache, scanProfiles } from './scanner.js'
import type { PatchEntry, ProfileManifest } from './types.js'

export interface CreateProfileOptions {
  bundles?: string[]
  dependencies?: Record<string, string>
}

/** 新建一个 Profile（默认带 @deepseek-ai/dsh-base + dsh-web-app 两个基础 bundle）。 */
export function createProfile(profilesDir: string, name: string, opts: CreateProfileOptions = {}): string {
  const dir = join(profilesDir, name)
  if (existsSync(dir)) throw new Error(`Profile 已存在: ${name}`)

  const manifest: ProfileManifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: opts.dependencies ?? {},
    dsh: {
      profile: {
        bundles: opts.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      },
    },
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), '# 用户的启用/禁用/配置层\n[]\n', 'utf8')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')
  invalidateProfileCache(profilesDir)
  return dir
}

/** 删除一个 Profile（安全校验：必须存在且包含 package.json）。 */
export function removeProfile(profilesDir: string, name: string): void {
  const profile = findProfile(profilesDir, name)
  if (!profile) throw new Error(`Profile 不存在: ${name}`)
  if (!existsSync(profile.packageJsonPath)) throw new Error(`拒绝删除非 Profile 目录: ${name}`)
  rmSync(profile.dir, { recursive: true, force: true })
  invalidateProfileCache(profilesDir)
}

/** 更新 Profile 的 bundles 列表。 */
export function setProfileBundles(profilesDir: string, name: string, bundles: string[]): void {
  const profile = findProfile(profilesDir, name)
  if (!profile?.manifest) throw new Error(`Profile 不存在或 manifest 不可读: ${name}`)
  const next: ProfileManifest = {
    ...profile.manifest,
    dsh: { profile: { bundles } },
  }
  writeFileSync(profile.packageJsonPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  invalidateProfileCache(profilesDir)
}

/**
 * 在 Profile 的 cordis.patch.yml 中启用/禁用指定插件。
 * disabled=true 时写入一条 insert + disabled 条目；false 时移除该 id 的禁用条目。
 * 写回前做可解析性检查：patch 含无法理解的结构时拒绝写回（防破坏用户配置）。
 */
export function setPluginDisabled(
  profilesDir: string,
  name: string,
  pluginId: string,
  disabled: boolean,
  pluginName?: string,
): void {
  const profile = findProfile(profilesDir, name)
  if (!profile) throw new Error(`Profile 不存在: ${name}`)
  const patchPath = profile.patchPath ?? join(profile.dir, 'cordis.patch.yml')

  let entries: PatchEntry[] = existsSync(patchPath) ? readPatchChecked(patchPath) : []

  // 清理已有该 id 的条目
  entries = entries
    .map((e) => {
      if (e.ids.includes(pluginId)) {
        const ids = e.ids.filter((i) => i !== pluginId)
        return ids.length ? { ...e, ids, disabledIds: e.disabledIds.filter((d) => d !== pluginId) } : null
      }
      return e
    })
    .filter((e): e is PatchEntry => e !== null)

  if (disabled) {
    entries.push({ op: 'insert', ids: [pluginId], disabledIds: [pluginId] })
  }

  writeFileSync(patchPath, serializePatchList(entries), 'utf8')
  invalidateProfileCache(profilesDir)
}

export { scanProfiles, findProfile }
