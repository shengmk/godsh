#!/usr/bin/env node
/**
 * 校验备份里的聊天记录**真的可读**（而不只是"文件拷过来了"）。
 *
 * 为什么不能只看文件数：dsh 的会话文件是 `<id>/session.v3.jsonl.zstd`，实测是**多个 zstd 帧
 * 首尾相接**（不是单个帧）。只做一次 zstd 解压会只得到第一帧的内容并静默丢弃其余部分 ——
 * 于是"解压成功"这个结论看似成立，实际丢掉大半对话。所以必须：
 *
 *   1. 按 zstd 魔数（`28 B5 2F FD`）把字节流切成帧；
 *   2. 逐帧解压并拼接；
 *   3. 再按行 JSON.parse，统计行数与解析失败数。
 *
 * 用法：node scripts/exp/verify-session-backup.mjs --dir <备份里的 sessions 目录> [--max 8] [--all]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const DIR = arg('dir', '')
const MAX = Number(arg('max', '8'))
const ALL = argv.includes('--all')

if (DIR === '') {
  console.error('用法: node scripts/exp/verify-session-backup.mjs --dir <sessions 目录> [--max N] [--all]')
  process.exit(2)
}

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 按魔数把字节流切成帧。 */
function splitFrames(buf) {
  const starts = []
  let i = 0
  while (i >= 0 && i < buf.length) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + MAGIC.length
  }
  const frames = []
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    frames.push(buf.subarray(from, to))
  }
  return frames
}

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name.endsWith('.zstd')) files.push({ path: p, size: st.size })
  }
}
walk(DIR)
files.sort((a, b) => b.size - a.size)

const pick = ALL ? files : files.slice(0, MAX)
const result = {
  dir: DIR,
  totalZstdFiles: files.length,
  checked: pick.length,
  allFramesDecoded: true,
  totalJsonLines: 0,
  totalBytes: 0,
  jsonParseFailures: 0,
  perFile: [],
  verdict: [],
}

for (const f of pick) {
  const buf = readFileSync(f.path)
  const frames = splitFrames(buf)
  let text = ''
  const frameErrors = []
  for (const [idx, frame] of frames.entries()) {
    try {
      text += zstdDecompressSync(frame).toString('utf8')
    } catch (e) {
      frameErrors.push(`frame#${idx}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  let bad = 0
  for (const line of lines) {
    try {
      JSON.parse(line)
    } catch {
      bad++
    }
  }
  if (frameErrors.length > 0) result.allFramesDecoded = false
  result.totalJsonLines += lines.length
  result.totalBytes += f.size
  result.jsonParseFailures += bad
  result.perFile.push({
    file: f.path.slice(DIR.length + 1).replace(/\\/g, '/'),
    bytes: f.size,
    frames: frames.length,
    jsonLines: lines.length,
    jsonParseFailures: bad,
    frameErrors,
  })
}

if (result.totalJsonLines === 0) {
  result.verdict.push('✘ 一条 JSON 记录都没解出来 —— 备份里的会话文件不可读')
} else if (!result.allFramesDecoded) {
  result.verdict.push('✘ 有 zstd 帧解压失败 —— 文件不完整或损坏')
} else if (result.jsonParseFailures > 0) {
  result.verdict.push(`✘ 有 ${result.jsonParseFailures} 行 JSON 解析失败 —— 内容可能被截断`)
} else {
  result.verdict.push(
    `★ 可读：${result.checked}/${result.totalZstdFiles} 个会话文件全帧解压成功，共 ${result.totalJsonLines} 行 JSON 全部解析通过（覆盖 ${(result.totalBytes / 1048576).toFixed(1)} MB）`
  )
}

console.log(JSON.stringify(result, null, 2))
