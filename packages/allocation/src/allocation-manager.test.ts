import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '@godsh/core'
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
