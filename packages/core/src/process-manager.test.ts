import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProcessesByProfile, killAllProfileProcesses } from './process-manager.js'
import { ConfigStore } from './config-store.js'
import { run } from './run.js'

test('findProcessesByProfile: 不存在的 profile 返回空数组', () => {
  const pids = findProcessesByProfile('non_existent_profile_xyz_' + Date.now())
  assert.ok(Array.isArray(pids))
  assert.equal(pids.length, 0)
})

test('findProcessesByProfile: 非法特殊字符环境名安全转义', () => {
  const pids = findProcessesByProfile(';rm -rf /; && calc.exe')
  assert.ok(Array.isArray(pids))
  assert.equal(pids.length, 0)
})

test('killAllProfileProcesses: 空 pid 目录安全执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pid-test-'))
  try {
    const res = await killAllProfileProcesses(dir, 'test-profile-none')
    assert.equal(res.killed, 0)
    assert.deepEqual(res.pids, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('killAllProfileProcesses: 自动清理 dead 状态的 service-pid 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pid-test-'))
  try {
    writeFileSync(join(dir, 'service-pid-49999.txt'), '9999999', 'utf8')
    assert.ok(existsSync(join(dir, 'service-pid-49999.txt')))

    await killAllProfileProcesses(dir, 'any-profile')
    assert.equal(existsSync(join(dir, 'service-pid-49999.txt')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ConfigStore: allowMultiPort 默认值为 false，可持久化保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-cfg-test-'))
  try {
    const store = new ConfigStore(dir)
    const cfg1 = store.readConfig()
    assert.equal(cfg1.webKernel.allowMultiPort, false)

    store.writeConfig({
      ...cfg1,
      webKernel: { ...cfg1.webKernel, allowMultiPort: true },
    })

    const cfg2 = store.readConfig()
    assert.equal(cfg2.webKernel.allowMultiPort, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run: 执行命令时触发 onLog 流式输出回调', async () => {
  const chunks: string[] = []
  const res = await run(process.execPath, ['-e', 'console.log("stream-test-1"); console.log("stream-test-2")'], {
    onLog: (chunk) => chunks.push(chunk),
  })

  assert.equal(res.ok, true)
  assert.equal(res.code, 0)
  assert.ok(res.stdout.includes('stream-test-1'))
  assert.ok(res.stdout.includes('stream-test-2'))
  assert.ok(chunks.length > 0)
  assert.ok(chunks.join('').includes('stream-test-1'))
})

