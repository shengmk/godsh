import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfile, exportProfilePackage, importProfilePackage } from './profile-editor.js'

test('exportProfilePackage: 正确导出环境配置包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pkg-test-'))
  try {
    createProfile(dir, 'test-env', {
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: { 'test-plugin': '^1.0.0' },
    })
    writeFileSync(join(dir, 'test-env', 'cordis.patch.yml'), '- insert:\n  - id: test-plugin\n', 'utf8')

    const pkg = exportProfilePackage(dir, 'test-env')
    assert.equal(pkg.format, 'godsh-profile-package')
    assert.equal(pkg.version, '1.0')
    assert.equal(pkg.name, 'test-env')
    assert.deepEqual(pkg.bundles, ['@deepseek-ai/dsh-base'])
    assert.deepEqual(pkg.dependencies, { 'test-plugin': '^1.0.0' })
    assert.ok(pkg.patchYaml.includes('test-plugin'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importProfilePackage: 从配置包完整复现环境', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pkg-test-'))
  try {
    const pkg = {
      format: 'godsh-profile-package' as const,
      version: '1.0',
      name: 'source-env',
      exportedAt: Date.now(),
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      dependencies: { 'my-addon': '2.0.0' },
      patchYaml: '- insert:\n  - id: my-addon\n',
    }

    const res = importProfilePackage(dir, 'imported-env', pkg)
    assert.equal(res.profile, 'imported-env')
    assert.equal(res.dependenciesCount, 1)
    assert.ok(existsSync(join(dir, 'imported-env', 'package.json')))
    assert.ok(existsSync(join(dir, 'imported-env', 'cordis.patch.yml')))

    const patchContent = readFileSync(join(dir, 'imported-env', 'cordis.patch.yml'), 'utf8')
    assert.ok(patchContent.includes('my-addon'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
