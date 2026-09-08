import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairAgent } from './repair-agent.js'

test('RepairAgent: 完整 7 阶段自愈工作流执行与 bundles 顺序矫正', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-repair-test-'))
  try {
    const dshHome = join(tmp, 'dsh-home')
    const profilesDir = join(tmp, 'profiles')
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(profilesDir, { recursive: true })

    const profileName = 'test-profile'
    const profileDir = join(profilesDir, profileName)
    mkdirSync(profileDir, { recursive: true })

    // 初始损坏的 package.json：缺少正确顺序，且包含 launcher-owned 的 dsh-plugin-desktop
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify(
        {
          name: 'test-profile',
          dsh: {
            profile: {
              bundles: [
                'some-custom-plugin',
                'dsh-plugin-desktop',
                '@deepseek-ai/dsh-web-app',
                '@deepseek-ai/dsh-base',
              ],
            },
          },
        },
        null,
        2
      )
    )

    let incidentCreated = false
    const logs: string[] = []

    const agent = new RepairAgent({
      dshHome,
      profilesDir,
      createIncidentSnapshot: (p, desc) => {
        incidentCreated = true
        return 'snap-incident-123'
      },
      onLog: (m) => logs.push(m),
    })

    const report = await agent.run(profileName)

    assert.equal(report.success, true)
    assert.equal(report.profile, profileName)
    assert.equal(report.phases.length, 7)
    assert.equal(incidentCreated, true)
    assert.equal(report.incidentSnapshotId, 'snap-incident-123')

    // 验证 Phase 6 对 bundles 的规范化矫正
    const fixedPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = fixedPkg.dsh.profile.bundles
    assert.equal(bundles[0], '@deepseek-ai/dsh-base')
    assert.equal(bundles[1], '@deepseek-ai/dsh-web-app')
    assert.equal(bundles.includes('dsh-plugin-desktop'), false)
    assert.equal(bundles.includes('some-custom-plugin'), true)

    // 验证 Phase 4 创建了默认 cordis.patch.yml
    assert.ok(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('[]'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('RepairAgent: 指定快照历史时执行原子回滚', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-repair-snap-'))
  try {
    const dshHome = join(tmp, 'dsh-home')
    const profilesDir = join(tmp, 'profiles')
    const profileName = 'snap-profile'
    const profileDir = join(profilesDir, profileName)
    mkdirSync(profileDir, { recursive: true })

    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'snap-profile',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      })
    )

    let restoredId = ''
    const agent = new RepairAgent({
      dshHome,
      profilesDir,
      targetSnapshotId: 'snap-target-999',
      restoreFromSnapshot: (p, id) => {
        restoredId = id
        return true
      },
    })

    const report = await agent.run(profileName)
    assert.equal(report.success, true)
    assert.equal(restoredId, 'snap-target-999')
    assert.equal(report.restoredSnapshotId, 'snap-target-999')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('RepairAgent: Profile 不存在时 Phase 1 失败并安全中止', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-repair-err-'))
  try {
    const agent = new RepairAgent({
      dshHome: join(tmp, 'dsh-home'),
      profilesDir: join(tmp, 'profiles'),
    })

    const report = await agent.run('non-existent')
    assert.equal(report.success, false)
    assert.ok(report.error?.includes('Profile 目录不存在'))
    assert.equal(report.phases.length, 1)
    assert.equal(report.phases[0]?.status, 'failed')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
