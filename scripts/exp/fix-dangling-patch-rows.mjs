#!/usr/bin/env node
/**
 * 悬空补丁行（dangling patch row）的检测与修复。
 *
 * 为什么需要它 —— 这是一类会让环境**直接打不开**的状态
 * ---------------------------------------------------
 * 当某个包被**写进** `<profile>/cordis.patch.yml`（或 `dsh.profile.bundles`），
 * 随后它的物理文件又被删掉（沙箱移除、手动删目录、pnpm 卸载）时，dsh 在启动装载阶段会抛：
 *
 *     dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
 *     failed to import loader entry <包名> (undefined): Cannot read properties of undefined (reading 'startsWith')
 *
 * 这不是"插件没生效"，而是**整棵树加载失败、环境起不来**。实测在把沙箱条目移除后复现过：
 * 沙箱引擎的 remove 会解除 Junction 挂载并清理 `package.json`/`bundles`，但它**不认识
 * 『分配层』**——如果这一行是被分配层写进去的，移除后补丁层就会留下一条指向已删包的悬空行。
 *
 * 本脚本把这种状态**查出来**，并可在显式 `--fix` 下清掉那一行（同时摘掉对应的分配记录，
 * 否则下一次任意 `applyProfile` 又会把它加回来）。
 *
 * 判据：补丁行里的 id 在 `<profile>/node_modules/` 下**真实可解析**（`lstat` + `realpath`，
 * 与 `@godsh/core` 的 `resolveProfilePackageDir` 同一口径 —— **不用 `existsSync`**，
 * 它在断链 junction 上的行为与"真实可解析"不一致）。
 *
 * 用法：
 *   node --import tsx scripts/exp/fix-dangling-patch-rows.mjs                       # 只检测
 *   node --import tsx scripts/exp/fix-dangling-patch-rows.mjs --fix                 # 检测并清理
 *   node --import tsx scripts/exp/fix-dangling-patch-rows.mjs --fix --profile web    # 只处理某个环境
 *
 * 环境变量：
 *   DSH_HOME                 DSH 家目录（默认 ~/.dsh）
 *   DSH_LAUNCHER_DATA_DIR    沙箱/分配数据目录（默认 %APPDATA%\godsh\data）—— 与启动器一致
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AllocationManager } from '@godsh/allocation'
import { ConfigStore, resolveProfilePackageDir } from '@godsh/core'
import { invalidateProfileCache, readPatchChecked } from '@godsh/profile-manager'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const FIX = argv.includes('--fix')
const ONLY = arg('profile', '')
const isOfficial = (id) => id.startsWith('@deepseek-ai/') && id.length > '@deepseek-ai/'.length

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const dataDir =
  process.env.DSH_LAUNCHER_DATA_DIR ?? join(process.env.APPDATA ?? join(dshHome, 'godsh'), 'godsh', 'data')
const profilesDir = join(dshHome, 'profiles')

console.log(`[dangling] DSH_HOME      = ${dshHome}`)
console.log(`[dangling] 数据目录      = ${dataDir}`)
console.log(`[dangling] profiles 目录 = ${profilesDir}`)
console.log(`[dangling] 模式          = ${FIX ? '检测并清理（--fix）' : '只检测'}`)

if (!existsSync(profilesDir)) {
  console.error(`[dangling] profiles 目录不存在：${profilesDir}`)
  process.exit(10)
}

const store = new ConfigStore(dataDir)
const allocations = new AllocationManager(store)

/** 待清理项：环境 → 悬空 id 列表。 */
const dangling = new Map()
let scannedProfiles = 0
let scannedRows = 0

for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (entry.name.startsWith('.')) continue
  if (ONLY !== '' && entry.name !== ONLY) continue
  const profileDir = join(profilesDir, entry.name)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) continue
  scannedProfiles++

  let rows = []
  try {
    rows = readPatchChecked(patchPath)
  } catch (err) {
    console.log(`  ✘ ${entry.name}: 补丁文件无法解析 —— ${err instanceof Error ? err.message : String(err)}`)
    continue
  }

  const bad = []
  for (const row of rows) {
    for (const id of row.ids ?? []) {
      scannedRows++
      // 官方包由 dsh 从安装目录解析，不参与本判据（前缀判定，与唯一事实源同口径）
      if (isOfficial(id)) continue
      if (resolveProfilePackageDir(profileDir, id) === null) bad.push(id)
    }
  }
  if (bad.length > 0) {
    dangling.set(entry.name, bad)
    console.log(`  ✘ ${entry.name}: 发现 ${bad.length} 条悬空补丁行 → ${bad.join(', ')}`)
  } else {
    console.log(`  ✓ ${entry.name}: ${rows.length} 行，全部可解析`)
  }
}

console.log(`\n[dangling] 扫描了 ${scannedProfiles} 个环境、${scannedRows} 条补丁 id；悬空 ${dangling.size} 个环境`)

if (dangling.size === 0) {
  console.log('[dangling] 没有悬空补丁行 ✅')
  process.exit(0)
}

if (!FIX) {
  console.log('[dangling] 如需清理，请加 --fix（会同时摘掉对应的分配记录）')
  process.exit(1)
}

let failed = 0
for (const [profile, ids] of dangling) {
  try {
    // 1) 先摘分配记录：否则下一次任何 applyProfile 都会把这些 id 再加回补丁层
    let removedRecords = 0
    for (const a of allocations.list()) {
      if (a.profile === profile && ids.includes(a.pluginId)) {
        allocations.remove(a.id)
        removedRecords++
      }
    }
    // 2) 再用 removedIds 把补丁行抹掉（applyProfile 会剔除 managedIds ∪ removedIds）
    allocations.applyProfile(profilesDir, profile, ids)
    invalidateProfileCache(profilesDir)
    console.log(`  ✔ ${profile}: 已清理 ${ids.length} 条悬空行（同时摘掉 ${removedRecords} 条分配记录）`)
  } catch (err) {
    failed++
    console.error(`  ✘ ${profile}: 清理失败 —— ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(failed === 0 ? '\n[dangling] 清理完成 ✅' : `\n[dangling] 有 ${failed} 个环境清理失败 ✘`)
process.exit(failed === 0 ? 0 : 2)
