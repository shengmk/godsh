import assert from 'node:assert/strict'
import test from 'node:test'
import { autoEnableAfterInstall } from './auto-enable.js'
import type { RouteContext } from './types.js'

/**
 * 缺陷 2（「安装即启用」）的离线单测。
 *
 * 为什么必须离线可跑：`autoEnableAfterInstall` 挂在**安装成功之后**的路径上，而真实的安装
 * 要走 `pnpm add`（联网）。冒烟测试里的假 profile 不会真的装包，所以那条路走不到这里 ——
 * 于是用一个假 `RouteContext` 直接把决策逻辑钉住，而不是靠"读过代码觉得没问题"。
 *
 * 覆盖的四个分支：
 *  1. 官方包 → 不纳管（不写分配、不写补丁层）；
 *  2. 新包 → allocate + 写回补丁层，返回 applied:true；
 *  3. 已存在但被禁用 → 必须显式改回启用（这正是不变量「启用是标准态」）；
 *  4. 写回失败 / 内部抛错 → **绝不抛出**，如实返回 applied:false 与原因（安装成功不能被改判成失败）。
 */

/** 记录调用轨迹的假 AllocationManager。 */
interface FakeAllocations {
  records: { id: string; profile: string; pluginId: string; pluginName: string; enabled: boolean; order: number }[]
  list(): { id: string; profile: string; pluginId: string; enabled: boolean }[]
  allocate(profile: string, pluginId: string, pluginName: string): { id: string }
  setEnabled(id: string, enabled: boolean): void
  calls: string[]
}

function makeAllocations(seed: { id: string; profile: string; pluginId: string; enabled: boolean }[] = []): FakeAllocations {
  const calls: string[] = []
  const records = seed.map((s, i) => ({ ...s, pluginName: s.pluginId, order: i }))
  return {
    records,
    calls,
    list() {
      return records.map((r) => ({ id: r.id, profile: r.profile, pluginId: r.pluginId, enabled: r.enabled }))
    },
    allocate(profile, pluginId, pluginName) {
      calls.push(`allocate(${profile},${pluginId})`)
      const existing = records.find((r) => r.profile === profile && r.pluginId === pluginId)
      if (existing !== undefined) return { id: existing.id }
      const rec = { id: `id-${pluginId}`, profile, pluginId, pluginName, enabled: true, order: records.length }
      records.push(rec)
      return { id: rec.id }
    },
    setEnabled(id, enabled) {
      calls.push(`setEnabled(${id},${String(enabled)})`)
      const rec = records.find((r) => r.id === id)
      if (rec !== undefined) rec.enabled = enabled
    },
  }
}

/** 造一个只带本测试需要成员的假 RouteContext。 */
function makeCtx(
  allocations: FakeAllocations,
  apply: { applied: boolean; applyError?: string } = { applied: true },
  throwOnList = false,
): { ctx: RouteContext; calls: string[] } {
  const applyCalls: string[] = []
  const fake = {
    allocations: {
      list: () => {
        if (throwOnList) throw new Error('模拟 list() 抛错')
        return allocations.list()
      },
      allocate: (p: string, id: string, name: string) => allocations.allocate(p, id, name),
      setEnabled: (id: string, enabled: boolean) => allocations.setEnabled(id, enabled),
    },
    tryApplyAllocation: (profile: string) => {
      applyCalls.push(profile)
      return apply
    },
  }
  return { ctx: fake as unknown as RouteContext, calls: applyCalls }
}

test('autoEnableAfterInstall: 官方包不纳管（不写分配、不写补丁层）', () => {
  const allocations = makeAllocations()
  const { ctx, calls } = makeCtx(allocations)
  const r = autoEnableAfterInstall(ctx, 'alpha', '@deepseek-ai/dsh-web-app')
  assert.equal(r.applied, false)
  assert.match(r.message, /官方/)
  assert.equal(allocations.calls.length, 0, '官方包不得触发 allocate')
  assert.equal(calls.length, 0, '官方包不得触发 tryApplyAllocation')
})

test('autoEnableAfterInstall: 新包 → allocate 并写回补丁层，applied=true', () => {
  const allocations = makeAllocations()
  const { ctx, calls } = makeCtx(allocations)
  const r = autoEnableAfterInstall(ctx, 'alpha', 'dsh-skill-hub')
  assert.equal(r.applied, true)
  assert.equal(r.allocationId, 'id-dsh-skill-hub')
  assert.deepEqual(allocations.calls, ['allocate(alpha,dsh-skill-hub)'])
  assert.deepEqual(calls, ['alpha'], '必须写回该环境的 cordis.patch.yml')
})

test('autoEnableAfterInstall: 已存在但被禁用 → 显式改回启用（启用是标准态）', () => {
  const allocations = makeAllocations([{ id: 'rec-1', profile: 'alpha', pluginId: 'dsh-im', enabled: false }])
  const { ctx } = makeCtx(allocations)
  const r = autoEnableAfterInstall(ctx, 'alpha', 'dsh-im')
  assert.equal(r.applied, true)
  assert.deepEqual(allocations.calls, ['allocate(alpha,dsh-im)', 'setEnabled(rec-1,true)'])
  assert.equal(allocations.records[0]?.enabled, true)
})

test('autoEnableAfterInstall: 已是启用态 → 不重复改启用位，但仍写回一次（幂等）', () => {
  const allocations = makeAllocations([{ id: 'rec-2', profile: 'alpha', pluginId: 'dsh-im', enabled: true }])
  const { ctx } = makeCtx(allocations)
  const r = autoEnableAfterInstall(ctx, 'alpha', 'dsh-im')
  assert.equal(r.applied, true)
  assert.deepEqual(allocations.calls, ['allocate(alpha,dsh-im)'], '不应调用 setEnabled')
})

test('autoEnableAfterInstall: 写回补丁层失败 → applied=false 且带原因，绝不抛', () => {
  const allocations = makeAllocations()
  const { ctx } = makeCtx(allocations, { applied: false, applyError: '模拟写盘失败' })
  const r = autoEnableAfterInstall(ctx, 'alpha', 'dsh-x')
  assert.equal(r.applied, false)
  assert.match(r.message, /模拟写盘失败/)
  assert.match(r.message, /插件已安装/, '必须说明安装本身没有被改判成失败')
})

test('autoEnableAfterInstall: 空包名 → 不做事且不抛', () => {
  const allocations = makeAllocations()
  const { ctx } = makeCtx(allocations)
  const r = autoEnableAfterInstall(ctx, 'alpha', '   ')
  assert.equal(r.applied, false)
  assert.equal(allocations.calls.length, 0)
})

test('autoEnableAfterInstall: 内部抛错被吞掉并如实返回（绝不让它穿到安装响应上）', () => {
  const allocations = makeAllocations()
  const { ctx } = makeCtx(allocations, { applied: true }, true)
  const r = autoEnableAfterInstall(ctx, 'alpha', 'dsh-y')
  assert.equal(r.applied, false)
  assert.match(r.message, /自动启用失败/)
  assert.match(r.message, /模拟 list\(\) 抛错/)
})
