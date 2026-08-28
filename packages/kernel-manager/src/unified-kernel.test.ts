import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '@dsh-launcher/core'
import { UnifiedKernelManager, WEB_APP_BUNDLE } from './unified-kernel.js'
import type { ProfileInfo } from '@dsh-launcher/profile-manager'

function setup(): { uk: UnifiedKernelManager; dir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'dshl-uk-data-'))
  const dir = mkdtempSync(join(tmpdir(), 'dshl-uk-'))
  return { uk: new UnifiedKernelManager(new ConfigStore(dataDir)), dir }
}

function makeProfile(dir: string, name: string, bundles: string[]): ProfileInfo {
  const pdir = join(dir, name)
  mkdirSync(pdir, { recursive: true })
  writeFileSync(
    join(pdir, 'package.json'),
    JSON.stringify({ name, dependencies: {}, dsh: { profile: { bundles } } }),
    'utf8',
  )
  return { name, dir: pdir, exists: true, manifest: null, bundles, dependencies: {}, packageJsonPath: join(pdir, 'package.json'), patchPath: null, patchEntries: 0, patchDisabled: [] }
}

function readBundles(dir: string, name: string): string[] {
  const pkg = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  return pkg.dsh?.profile?.bundles ?? []
}

test('默认 enabled=true，web-app 紧跟 dsh-base 注入', () => {
  const { uk, dir } = setup()
  const p = makeProfile(dir, 'open-design', ['@deepseek-ai/dsh-base'])
  const r = uk.applyToProfile(p)
  assert.deepEqual(r.added, [WEB_APP_BUNDLE])
  assert.deepEqual(readBundles(dir, 'open-design'), ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
})

test('幂等：重复应用不重复添加', () => {
  const { uk, dir } = setup()
  const p = makeProfile(dir, 'web', ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
  const r = uk.applyToProfile(p)
  assert.deepEqual(r.added, [])
  assert.deepEqual(readBundles(dir, 'web'), ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE])
})

test('用户插件追加尾部；禁用项不注入', () => {
  const { uk, dir } = setup()
  const p = makeProfile(dir, 'web', ['@deepseek-ai/dsh-base'])
  uk.addPlugin('dshmarket', 'dshmarket')
  uk.addPlugin('disabled-one', 'disabled-one')
  uk.setEnabled('disabled-one', false)
  uk.applyToProfile(p)
  const bundles = readBundles(dir, 'web')
  assert.ok(bundles.includes('dshmarket'))
  assert.ok(!bundles.includes('disabled-one'))
})

test('还原：只移除本管理器记录项，保留用户原有条目', () => {
  const { uk, dir } = setup()
  const p = makeProfile(dir, 'web', ['@deepseek-ai/dsh-base', 'user-plugin'])
  uk.applyToProfile(p) // 注入 web-app
  assert.ok(readBundles(dir, 'web').includes(WEB_APP_BUNDLE))
  const r = uk.revertProfile(p)
  assert.deepEqual(r.added, [WEB_APP_BUNDLE])
  const after = readBundles(dir, 'web')
  assert.ok(!after.includes(WEB_APP_BUNDLE))
  assert.ok(after.includes('user-plugin'), '用户条目必须保留')
  assert.ok(after.includes('@deepseek-ai/dsh-base'))
})

test('reorder: 调整统一内核插件顺序', () => {
  const { uk } = setup()
  uk.addPlugin('b', 'b')
  uk.addPlugin('a', 'a')
  uk.addPlugin('c', 'c')
  uk.reorder(['c', 'a', 'b'])
  assert.deepEqual(uk.read().plugins.map((x) => x.id), ['c', 'a', 'b'])
})
