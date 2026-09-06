import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyProfileDeps,
  healProfilesNodeModules,
  readPkgVersion,
  ensureCompatibilityShims,
} from './dsh-heal.js'

test('readPkgVersion: 正确读取 package.json 中的版本号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ver-test-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '0.1.2-rc.1' }))
    assert.equal(readPkgVersion(dir), '0.1.2-rc.1')
    assert.equal(readPkgVersion(join(dir, 'nonexistent')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyProfileDeps: 检测官方 bundle 缺失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof-test-'))
  try {
    const profileDir = join(dir, 'test-profile')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    const res = verifyProfileDeps(profileDir)
    assert.equal(res.ok, false)
    assert.ok(res.problems.some((p) => p.includes('@deepseek-ai/dsh-base')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyProfileDeps: 检测旧版 dsh-tool-subagent 缺少 model-selection-settings 导出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof-test-'))
  try {
    const profileDir = join(dir, 'test-profile')
    const scoped = join(profileDir, 'node_modules', '@deepseek-ai')
    mkdirSync(join(scoped, 'dsh-base'), { recursive: true })
    writeFileSync(join(scoped, 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.2-rc.1' }))

    const subagentDir = join(scoped, 'dsh-tool-subagent')
    mkdirSync(subagentDir, { recursive: true })
    writeFileSync(
      join(subagentDir, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-tool-subagent',
        version: '0.1.1-rc.2',
        exports: {
          '.': './lib/index.js',
        },
      })
    )

    const res = verifyProfileDeps(profileDir)
    assert.equal(res.ok, false)
    assert.ok(res.problems.some((p) => p.includes('model-selection-settings')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('healProfilesNodeModules: 自动替换过旧版本的 junction 链接', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-heal-test-'))
  try {
    const dshHome = join(tmpRoot, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'test-prof')
    const profileNm = join(profileDir, 'node_modules')
    const profileScoped = join(profileNm, '@deepseek-ai')
    mkdirSync(profileScoped, { recursive: true })

    const oldCache = join(tmpRoot, 'old-cache')
    mkdirSync(join(oldCache, '@deepseek-ai', 'dsh-base'), { recursive: true })
    writeFileSync(join(oldCache, '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.1-rc.2' }))

    symlinkSync(join(oldCache, '@deepseek-ai', 'dsh-base'), join(profileScoped, 'dsh-base'), 'junction')
    assert.equal(readPkgVersion(join(profileScoped, 'dsh-base')), '0.1.1-rc.2')

    const activeRuntime = join(tmpRoot, 'active-runtime')
    const activeNm = join(activeRuntime, 'node_modules')
    mkdirSync(join(activeNm, '@deepseek-ai', 'dsh-base'), { recursive: true })
    writeFileSync(join(activeNm, '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.2-rc.1' }))
    const activeBin = join(activeRuntime, 'lib', 'bin.js')
    mkdirSync(join(activeRuntime, 'lib'), { recursive: true })
    writeFileSync(activeBin, '// bin')

    const result = healProfilesNodeModules(dshHome, false, activeBin)
    assert.ok(result.healed > 0)
    assert.equal(readPkgVersion(join(profileScoped, 'dsh-base')), '0.1.2-rc.1')
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('ensureCompatibilityShims: 自动为 dsh-client-connection 注入 loopback 自动授权垫片', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-shim-test-'))
  try {
    const connDir = join(tmpRoot, '@deepseek-ai', 'dsh-client-connection', 'lib')
    mkdirSync(connDir, { recursive: true })
    const mockCode = `
    authorizeIndex(req, res) {
      if (tokens.length > 0) {
        this.writeUnauthorized(req, res);
        return false;
      }
      if (this.isAuthenticated(req)) return true;
      this.writeUnauthorized(req, res);
      return false;
    }
    requestRejection(request) {
      if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
      return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
    }
    `
    writeFileSync(join(connDir, 'index.js'), mockCode, 'utf8')

    const shimmed = ensureCompatibilityShims(tmpRoot)
    assert.equal(shimmed, 1)

    const patchedCode = readFileSync(join(connDir, 'index.js'), 'utf8')
    assert.ok(patchedCode.includes('/* godsh loopback auto-auth */'))
    assert.ok(patchedCode.includes('authority.startsWith("127.0.0.1")'))
    assert.ok(patchedCode.includes('sessionCookie('))

    // 再次执行应具备幂等性
    const shimmedAgain = ensureCompatibilityShims(tmpRoot)
    assert.equal(shimmedAgain, 0)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})
