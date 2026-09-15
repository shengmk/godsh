import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, isOfficialPackage } from '@godsh/core'
import { AllocationManager } from './allocation-manager.js'

function setup(): { store: ConfigStore; manager: AllocationManager; dir: string; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'dshl-alloc-data-'))
  const dir = mkdtempSync(join(tmpdir(), 'dshl-alloc-'))
  const store = new ConfigStore(dataDir)
  return { store, manager: new AllocationManager(store), dir, dataDir }
}

function makeProfile(dir: string, name: string, patch: string): string {
  const pdir = join(dir, name)
  mkdirSync(pdir, { recursive: true })
  writeFileSync(join(pdir, 'package.json'), JSON.stringify({ name, dependencies: {} }), 'utf8')
  writeFileSync(join(pdir, 'cordis.patch.yml'), patch, 'utf8')
  return pdir
}

test('allocate: 新建分配并幂等去重', () => {
  const { manager } = setup()
  const a = manager.allocate('web', 'dsh-memory', 'dsh-memory')
  assert.ok(a.id)
  assert.equal(a.enabled, true)
  const again = manager.allocate('web', 'dsh-memory', 'dsh-memory')
  assert.equal(again.id, a.id) // 幂等：同一 profile+plugin 不重复创建
  assert.equal(manager.list().length, 1)
})

test('setEnabled / reorder / remove 往返', () => {
  const { manager } = setup()
  const a = manager.allocate('web', 'a', 'a')
  const b = manager.allocate('web', 'b', 'b')
  const c = manager.allocate('web', 'c', 'c')
  manager.setEnabled(b.id, false)
  assert.equal(manager.listByProfile('web').find((x) => x.id === b.id)!.enabled, false)
  // 反转顺序
  manager.reorder('web', [c.id, b.id, a.id])
  const ids = manager.listByProfile('web').map((x) => x.id)
  assert.deepEqual(ids, [c.id, b.id, a.id])
  manager.remove(a.id)
  assert.equal(manager.list().find((x) => x.id === a.id), undefined)
})

test('applyProfile: 保留用户自定义条目，只重写本管理器条目', () => {
  const { manager, dir } = setup()
  makeProfile(dir, 'web', `- insert:\n    - id: user-custom\n    - id: managed-one\n`)
  manager.allocate('web', 'managed-one', 'managed-one')
  const patchPath = manager.applyProfile(dir, 'web')
  const out = readFileSync(patchPath, 'utf8')
  assert.ok(out.includes('user-custom'), '用户条目必须保留')
  assert.ok(out.includes('managed-one'))
})

test('applyProfile: 无分配且原本无 patch 时不创建空文件', () => {
  const { manager, dir } = setup()
  const pdir = join(dir, 'empty')
  mkdirSync(pdir, { recursive: true })
  writeFileSync(join(pdir, 'package.json'), '{}', 'utf8')
  const path = manager.applyProfile(dir, 'empty')
  assert.equal(path, join(pdir, 'cordis.patch.yml'))
  assert.equal(existsSync(path), false)
})

test('applyProfile: patch 含不可解析结构时拒绝写回（抛错，不破坏原文件）', () => {
  const { manager, dir } = setup()
  const pdir = makeProfile(dir, 'web', `- insert:\n    - id: a\n      config:\n        nested: true\n`)
  manager.allocate('web', 'b', 'b')
  assert.throws(() => manager.applyProfile(dir, 'web'), /无法安全重写/)
  // 原文件未被破坏
  const raw = readFileSync(join(pdir, 'cordis.patch.yml'), 'utf8')
  assert.ok(raw.includes('config:') && raw.includes('nested'))
})

test('applyProfile: 写回前生成备份文件', () => {
  const { manager, dir, dataDir } = setup()
  makeProfile(dir, 'web', `- insert:\n    - id: existing\n`)
  manager.allocate('web', 'new-one', 'new-one')
  manager.applyProfile(dir, 'web')
  const backupDir = join(dataDir, 'patches-backup')
  assert.ok(existsSync(backupDir), '备份目录应存在')
  const files = readdirSync(backupDir)
  assert.ok(files.length >= 1, `应有备份文件，实际: ${files.join(',')}`)
})

test('applyProfile: removedIds 从 patch 清理', () => {
  const { manager, dir } = setup()
  makeProfile(dir, 'web', `- insert:\n    - id: gone\n    - id: keep\n`)
  const patchPath = manager.applyProfile(dir, 'web', ['gone'])
  const out = readFileSync(patchPath, 'utf8')
  assert.ok(!out.includes('gone'), '被删除的插件应从 patch 清理')
  assert.ok(out.includes('keep'))
})

// ---------- 官方 bundle 判据：经由本模块真实调用路径（applyProfile 的 patch 剔除）验证 ----------
//
// 本模块**不再导出**自己的官方判定函数，也不持有任何包名枚举：三处剔除点（existing 的 ids /
// disabledIds、toPatchEntries）直接调用 `@godsh/core` 的 isOfficialPackage。因此「判据是什么」
// 只能通过真实行为断言 —— 下面把官方包放进 patch，看 applyProfile 写回后它是否被剔除。

/** 用一条 insert 条目构造 patch 文本（id 一律加引号，避免 YAML 把 @ 当保留指示符）。 */
function patchWithIds(ids: string[], disabled: string[] = []): string {
  const lines = ['- insert:']
  for (const id of ids) {
    lines.push(`    - id: "${id}"`)
    if (disabled.includes(id)) lines.push('      disabled: true')
  }
  return lines.join('\n') + '\n'
}

test('applyProfile: 三个官方内核 bundle 一律从 patch 中剔除（含 disabled 引用）', () => {
  const { manager, dir } = setup()
  makeProfile(
    dir,
    'web',
    patchWithIds(
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'keep-me'],
      ['@deepseek-ai/dsh-headless'],
    ),
  )
  const out = readFileSync(manager.applyProfile(dir, 'web'), 'utf8')
  assert.ok(!out.includes('@deepseek-ai/'), `官方 bundle 必须全部剔除，实际写回:\n${out}`)
  assert.ok(out.includes('keep-me'), '非官方条目必须保留')
  assert.ok(!out.includes('disabled'), '被剔除的官方 id 不得残留在 disabledIds 中')
})

test('applyProfile: 相似前缀 / 裸短名 / 只有前缀的畸形输入不得被误判为官方', () => {
  // 这几条是防「相似前缀误判」的关键：前缀必须逐字符相同且短名非空 —— 它们都应被原样保留
  const notOfficial = ['@deepseek-ai-extra/dsh-base', 'dsh-base', '@deepseek-ai/', '@deepseek-ai', '@DeepSeek-AI/dsh-base', 'dsh-memory']
  const { manager, dir } = setup()
  makeProfile(dir, 'web', patchWithIds(notOfficial))
  const out = readFileSync(manager.applyProfile(dir, 'web'), 'utf8')
  for (const id of notOfficial) {
    assert.ok(out.includes(id), `非官方 id 被误剔除: ${id}\n实际写回:\n${out}`)
  }
})

test('applyProfile: 官方将来新增的包自动被剔除（前缀判定而非枚举的价值）', () => {
  const { manager, dir } = setup()
  makeProfile(dir, 'web', patchWithIds(['@deepseek-ai/dsh-brand-new', '@deepseek-ai/dsh-future-thing', 'keep-me']))
  const out = readFileSync(manager.applyProfile(dir, 'web'), 'utf8')
  assert.ok(!out.includes('dsh-brand-new'), '官方新增包必须自动被剔除，无需改代码')
  assert.ok(!out.includes('dsh-future-thing'))
  assert.ok(out.includes('keep-me'))
})

test('applyProfile: 逐输入与 @godsh/core 的 isOfficialPackage 结果一致（本模块无第二份判据）', () => {
  // 「保留与否」必须恰好等于 `!isOfficialPackage(id)`：若本模块另抄了一份实现，这里会先炸。
  const inputs = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-brand-new',
    '@deepseek-ai/dsh-mcp-client',
    '@deepseek-ai/',
    '@deepseek-ai',
    '@deepseek-ai-extra/dsh-base',
    '@other/dsh-base',
    '@DeepSeek-AI/dsh-base',
    'dsh-base',
    'dsh-web-app',
    'dsh-headless',
    'dsh-memory',
    'dshmarket',
  ]
  for (const id of inputs) {
    const { manager, dir } = setup()
    makeProfile(dir, 'web', patchWithIds([id]))
    const out = readFileSync(manager.applyProfile(dir, 'web'), 'utf8')
    assert.equal(
      out.includes(id),
      !isOfficialPackage(id),
      `applyProfile 的剔除结果与 @godsh/core 判据不一致: ${id}（写回内容:\n${out}）`,
    )
  }
})
