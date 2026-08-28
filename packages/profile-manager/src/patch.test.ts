import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPatchParsable, parsePatchList, readPatchChecked, serializePatchList } from './patch.js'

test('parsePatchList: 解析规范 insert 列表', () => {
  const raw = `- insert:
    - id: @deepseek-ai/dsh-base
    - id: dsh-memory
      disabled: true
`
  const entries = parsePatchList(raw)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.op, 'insert')
  assert.deepEqual(entries[0]!.ids, ['@deepseek-ai/dsh-base', 'dsh-memory'])
  assert.deepEqual(entries[0]!.disabledIds, ['dsh-memory'])
})

test('parsePatchList: 支持多个 op 块与空数组', () => {
  const raw = `- insert:
    - id: a
- remove:
    - id: b
`
  const entries = parsePatchList(raw)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.ids[0], 'a')
  assert.equal(entries[1]!.op, 'remove')
  // 空数组 [] 解析为空
  assert.deepEqual(parsePatchList('[]'), [])
})

test('parsePatchList: 带注释与引号 id', () => {
  const raw = `# 用户自定义注释
- insert:
    - id: "quoted-id"
`
  const entries = parsePatchList(raw)
  assert.equal(entries[0]!.ids[0], 'quoted-id')
})

test('serializePatchList: 序列化往返一致', () => {
  const raw = `- insert:
    - id: a
      disabled: true
    - id: b
`
  const entries = parsePatchList(raw)
  const out = serializePatchList(entries)
  const again = parsePatchList(out)
  assert.deepEqual(again, entries)
})

test('checkPatchParsable: 规范结构零未识别行', () => {
  const raw = `# 注释
- insert:
    - id: a
      disabled: true
- update:
    - id: b
[]
`
  assert.deepEqual(checkPatchParsable(raw), [])
})

test('checkPatchParsable: 识别嵌套配置 / !!js / $patch 为不可安全重写', () => {
  const raw = `- insert:
    - id: a
      config:
        nested: true
    - id: b
      $patch:
        foo: bar
`
  const bad = checkPatchParsable(raw)
  // 保守策略：config:/nested/~/patch:/foo 4 行都视为无法识别（含子行）
  assert.ok(bad.length >= 4, `应识别嵌套结构行，实际: ${bad.join('|')}`)
  assert.ok(bad.some((l) => l.includes('config:')))
  assert.ok(bad.some((l) => l.includes('$patch')))
})

test('readPatchChecked: 不可解析时抛错并给出行样本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshl-patch-'))
  try {
    const p = join(dir, 'cordis.patch.yml')
    writeFileSync(p, `- insert:\n    - id: a\n      config:\n        nested: true\n`, 'utf8')
    assert.throws(() => readPatchChecked(p), /无法安全重写/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readPatchChecked: 可解析时正常返回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshl-patch-'))
  try {
    const p = join(dir, 'cordis.patch.yml')
    writeFileSync(p, `- insert:\n    - id: a\n`, 'utf8')
    const entries = readPatchChecked(p)
    assert.equal(entries[0]!.ids[0], 'a')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
