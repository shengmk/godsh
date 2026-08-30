import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProfileWorkspace } from './profile-editor.js'

function makeProfile(dir: string, name: string, wsContent: string): void {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'pnpm-workspace.yaml'), wsContent, 'utf8')
}

test('ensureProfileWorkspace: 为旧 workspace 补齐 minimumReleaseAge: 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshl-ws-'))
  try {
    // 模拟旧版 godsh 生成的 workspace（无 minimumReleaseAge）
    const oldWs = [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'allowBuilds:',
      '  cpu-features: true',
      "  '*': true",
      '',
    ].join('\n')
    makeProfile(dir, 'web', oldWs)
    const fixed = ensureProfileWorkspace(dir)
    assert.equal(fixed, 1)
    const out = readFileSync(join(dir, 'web', 'pnpm-workspace.yaml'), 'utf8')
    assert.match(out, /minimumReleaseAge:\s*0/)
    // 幂等：再次运行不再改动
    assert.equal(ensureProfileWorkspace(dir), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureProfileWorkspace: 已有 minimumReleaseAge 时不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshl-ws2-'))
  try {
    const ws = 'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAge: 10080\n'
    makeProfile(dir, 'web', ws)
    const fixed = ensureProfileWorkspace(dir)
    assert.equal(fixed, 0)
    const out = readFileSync(join(dir, 'web', 'pnpm-workspace.yaml'), 'utf8')
    assert.match(out, /minimumReleaseAge:\s*10080/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureProfileWorkspace: 缺文件时创建含 minimumReleaseAge 的新模板', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshl-ws3-'))
  try {
    mkdirSync(join(dir, 'web'), { recursive: true })
    const fixed = ensureProfileWorkspace(dir)
    assert.equal(fixed, 1)
    const out = readFileSync(join(dir, 'web', 'pnpm-workspace.yaml'), 'utf8')
    assert.match(out, /minimumReleaseAge:\s*0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})