import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HARVESTED_ID_PREFIX,
  inferVaultOrigin,
  isNpmUpdatable,
  isUpdatableEntry,
  originLabel,
  type OriginCarrier,
} from './vault-origin.js'

/**
 * 缺陷 3 前半（「沙箱不能全部更新」）的**离线**单测。
 *
 * 为什么必须单独钉住这条判据：`checkUpdates()` 会联网，而缺陷的成因恰恰是
 * 「**哪些条目会被送进更新器**」这一步选错了 —— 那是纯函数，可以在离线状态下断言。
 * 如果只测端到端的"点了按钮有没有更新成功"，一旦网络或镜像波动就无法区分
 * 「判据把收割条目排除了」和「npm 查不到版本」这两种完全不同的失败。
 */

const base: OriginCarrier = { id: 'x', source: 'local' }

test('inferVaultOrigin: 显式 origin 优先于一切推断', () => {
  const o = { kind: 'dir' as const, ref: 'r' }
  assert.deepEqual(inferVaultOrigin({ ...base, origin: o, childOrigin: 'shared-copy', source: 'market' }), o)
})

test('inferVaultOrigin: 收割条目（id 前缀）判为 profile-harvest，并带上源环境', () => {
  const r = inferVaultOrigin({
    id: `${HARVESTED_ID_PREFIX}dsh-mnemon-0.1.1`,
    source: 'local',
    installedProfiles: ['hajimi', 'web'],
  })
  assert.deepEqual(r, { kind: 'profile-harvest', ref: 'hajimi' })
})

test('inferVaultOrigin: 收割条目但没有 installedProfiles 时仍判为 profile-harvest（只是没有 ref）', () => {
  assert.deepEqual(inferVaultOrigin({ id: `${HARVESTED_ID_PREFIX}foo`, source: 'local' }), { kind: 'profile-harvest' })
})

test('inferVaultOrigin: market → npm；其它 local → dir', () => {
  assert.deepEqual(inferVaultOrigin({ id: 'dsh-x@1.0.0', source: 'market' }), { kind: 'npm' })
  assert.deepEqual(inferVaultOrigin({ id: 'my-local-thing', source: 'local' }), { kind: 'dir' })
})

test('inferVaultOrigin: shared-copy 的优先级高于收割前缀与 source', () => {
  assert.deepEqual(
    inferVaultOrigin({ id: `${HARVESTED_ID_PREFIX}x`, source: 'market', childOrigin: 'shared-copy' }),
    { kind: 'shared-copy' },
  )
})

test('isNpmUpdatable: 只有 npm 与 profile-harvest 可自动更新', () => {
  assert.equal(isNpmUpdatable({ kind: 'npm' }), true)
  assert.equal(isNpmUpdatable({ kind: 'profile-harvest' }), true)
  assert.equal(isNpmUpdatable({ kind: 'dir' }), false)
  assert.equal(isNpmUpdatable({ kind: 'shared-copy' }), false)
})

test('isUpdatableEntry —— 本缺陷的核心判据：收割条目必须**可以**更新', () => {
  // 这是修复前会失败的那一条：旧实现用 `source !== 'local'` 过滤，
  // 而收割条目正是 source === 'local'，于是永远进不了更新器。
  assert.equal(isUpdatableEntry({ id: `${HARVESTED_ID_PREFIX}dsh-mnemon`, source: 'local' }), true, '收割条目必须可更新')
  // 市场来源仍是可更新的（保持既有行为）
  assert.equal(isUpdatableEntry({ id: 'dsh-x@1.0.0', source: 'market' }), true)
  // 本地目录导入不可自动更新
  assert.equal(isUpdatableEntry({ id: 'some-local-dir', source: 'local' }), false)
  // shared-copy 一律排除（隔离不变量）
  assert.equal(
    isUpdatableEntry({ id: `${HARVESTED_ID_PREFIX}x`, source: 'market', childOrigin: 'shared-copy' }),
    false,
  )
  assert.equal(isUpdatableEntry({ id: 'dsh-x@1.0.0', source: 'market', childOrigin: 'shared-copy' }), false)
  // standalone 子副本不因 childOrigin 被排除（它自己的目录是独占的）
  assert.equal(
    isUpdatableEntry({ id: `${HARVESTED_ID_PREFIX}y`, source: 'local', childOrigin: 'standalone' }),
    true,
  )
})

test('originLabel: 四类来源都有中文标签，且收割标签带上源环境', () => {
  assert.equal(originLabel({ kind: 'npm' }), 'npm 包')
  assert.equal(originLabel({ kind: 'dir' }), '本地目录导入')
  assert.equal(originLabel({ kind: 'shared-copy' }), '共同占有的按父隔离副本')
  assert.match(originLabel({ kind: 'profile-harvest', ref: 'web' }), /web/)
  assert.match(originLabel({ kind: 'profile-harvest' }), /自环境收割/)
})
