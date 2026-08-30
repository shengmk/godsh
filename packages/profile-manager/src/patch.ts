import { readFileSync } from 'node:fs'
import type { PatchEntry } from './types.js'

function stripQuotes(value: string): string {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * 轻量解析 cordis.patch.yml 的“列表结构”，
 * 用于状态展示与分配管理，不依赖完整 YAML 库。
 * 支持两种缩进风格：
 *   - insert:
 *       - id: hello
 *         name: dsh-hello-plugin
 *         disabled: true
 *   或
 *   - insert:
 *     - id: hello
 *       name: dsh-hello-plugin
 *       disabled: true
 */
export function parsePatchList(raw: string): PatchEntry[] {
  const entries: PatchEntry[] = []
  let current: PatchEntry | null = null

  for (const line of raw.split(/\r?\n/)) {
    const opMatch = /^- (\w+):\s*$/.exec(line)
    if (opMatch) {
      if (current) entries.push(current)
      current = { op: opMatch[1] ?? '?', ids: [], disabledIds: [] }
      continue
    }
    if (!current) continue

    const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line) ?? /^\s+id:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      current.ids.push(stripQuotes(idMatch[1] ?? ''))
      continue
    }
    const disabledMatch = /^\s+disabled:\s*(true|false)\s*$/.exec(line)
    if (disabledMatch && disabledMatch[1] === 'true') {
      current.disabledIds.push(current.ids.at(-1) ?? '?')
    }
  }
  if (current) entries.push(current)
  return entries
}

export interface PatchSummary {
  entries: number
  ids: string[]
  disabledIds: string[]
}

export function parsePatchSummary(raw: string): PatchSummary {
  const entries = parsePatchList(raw)
  const ids: string[] = []
  const disabledIds: string[] = []
  for (const e of entries) {
    ids.push(...e.ids)
    disabledIds.push(...e.disabledIds)
  }
  return { entries: entries.length, ids, disabledIds }
}

/**
 * 序列化 id 值：以 @ / ! / $ 开头的裸值会被新版 dsh 的 YAML schema
 * 当作 !!js 表达式等特殊标记导致解析失败（"bad indentation of a mapping entry"），
 * 必须加双引号包裹；纯普通字符串（字母/数字/-/_/./空格）保持裸写。
 */
export function quoteIdIfNeeded(id: string): string {
  const v = id.trim()
  if (/^[@!$&*?|>%`]/.test(v) || /[{}[\],:#]/.test(v) || /[\r\n]/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return v
}

/** 将 patch 条目序列化为规范 YAML 列表。空列表返回合法空数组 `[]`（0 字节/空串会让 dsh 解析失败无法启动）。 */
export function serializePatchList(entries: PatchEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    lines.push(`- ${e.op}:`)
    for (const id of e.ids) {
      lines.push(`    - id: ${quoteIdIfNeeded(id)}`)
      if (e.disabledIds.includes(id)) lines.push(`      disabled: true`)
    }
  }
  if (lines.length === 0) return '[]\n'
  return lines.join('\n') + '\n'
}

/**
 * 可解析性检查：确认一段 cordis.patch.yml 是本工具能完整理解的结构。
 * 返回所有「无法识别」的行。空数组 = 可安全读-改-写回；非空 = 含未知结构，
 * 写回会丢失这些内容，调用方必须拒绝写回（防破坏用户配置）。
 *
 * 识别范围（与 parsePatchList 严格一致）：
 *   - 空行 / 注释（# 开头）
 *   - 顶层操作行 `- op:`（insert/update/remove/merge 等任意 op 名，均视为已知结构）
 *   - 条目行 `- id: xxx` 或 `  id: xxx`
 *   - 属性行 `  disabled: true|false` / `  enabled: true|false`
 *   - 空 patch 数组 `[]`
 * 其余任何行（嵌套配置、`!!js` 表达式、`$patch` 等）都会被视为无法识别。
 */
export function checkPatchParsable(raw: string): string[] {
  const unrecognized: string[] = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (trimmed === '[]') continue
    // 顶层操作行：- insert: / - update: / - remove: / - merge: / - $patch:
    if (/^-\s+\w+:(\s*)$/.test(trimmed) || /^-\s+\$[\w-]+:(\s*)$/.test(trimmed)) continue
    // 条目 id 行（列表项或缩进项）
    if (/^\s*-\s+id:\s*/.test(line) || /^\s+id:\s*/.test(line)) continue
    // 属性行（disabled / enabled；trimmed 已去缩进）
    if (/^disabled:\s*(true|false)\s*$/.test(trimmed)) continue
    if (/^enabled:\s*(true|false)\s*$/.test(trimmed)) continue
    unrecognized.push(line)
  }
  return unrecognized
}

/** 读 patch 并做可解析性检查；无法安全解析时抛错（写回前调用，防破坏用户配置）。 */
export function readPatchChecked(patchPath: string): PatchEntry[] {
  const raw = readFileSync(patchPath, 'utf8')
  const unrecognized = checkPatchParsable(raw)
  if (unrecognized.length > 0) {
    const sample = unrecognized.slice(0, 5).join('\n')
    throw new Error(
      `cordis.patch.yml 含 ${unrecognized.length} 行无法安全重写的结构（嵌套配置 / !!js 表达式 / $patch 等），` +
        `为保护你的配置已跳过本次写回。\n无法识别的行：\n${sample}`,
    )
  }
  return parsePatchList(raw)
}
