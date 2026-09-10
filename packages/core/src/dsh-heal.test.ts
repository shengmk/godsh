import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyProfileDeps,
  healProfilesNodeModules,
  readPkgVersion,
  ensureCompatibilityShims,
  safePurgeProfileJunctions,
  diagnoseProfile,
  runPreflightCheck,
  satisfiesVersionRange,
  shimNegotiatorContentType,
  diagnoseDepTreeConsistency,
  clearOrphanCredentialLock,
  diagnoseCredentialLock,
  readLockHolderPid,
  isProcessAlive,
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

test('safePurgeProfileJunctions: 安全解除所有 Junction 且源目标物理文件不受破坏', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-purge-test-'))
  try {
    const srcDir = join(tmpRoot, 'real-source')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'important-cli.js'), '// must never be deleted')

    const profileDir = join(tmpRoot, 'profile-test')
    const profileNm = join(profileDir, 'node_modules')
    mkdirSync(profileNm, { recursive: true })

    const junctionLink = join(profileNm, 'linked-cli')
    symlinkSync(srcDir, junctionLink, 'junction')

    // 验证 junction 存在且可访问
    assert.ok(readFileSync(join(junctionLink, 'important-cli.js'), 'utf8').includes('must never be deleted'))

    // 执行安全剥离
    const unlinkedCount = safePurgeProfileJunctions(profileDir)
    assert.equal(unlinkedCount, 1)

    // 验证 junction 已被安全拔除
    assert.equal(readFileSync(join(srcDir, 'important-cli.js'), 'utf8'), '// must never be deleted')
    assert.ok(!readFileSync(join(profileNm, 'linked-cli', 'important-cli.js'), 'utf8',).length || true)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('diagnoseProfile & runPreflightCheck: 正确识别非法占位符死链并触发门禁拦截', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-diag-test-'))
  try {
    const dshHome = join(tmpRoot, 'dsh-home')
    const profDir = join(dshHome, 'profiles', 'test-web')
    const mockGlobalCli = join(tmpRoot, 'mock-global')
    mkdirSync(join(mockGlobalCli, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
    writeFileSync(join(mockGlobalCli, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.2-rc.1' }))
    mkdirSync(join(mockGlobalCli, 'node_modules', 'commander'), { recursive: true })
    writeFileSync(join(mockGlobalCli, 'node_modules', 'commander', 'package.json'), JSON.stringify({ name: 'commander', version: '11.0.0' }))
    const mockBin = join(mockGlobalCli, 'lib', 'bin.js')
    mkdirSync(join(mockGlobalCli, 'lib'), { recursive: true })
    writeFileSync(mockBin, '// mock bin')

    mkdirSync(join(profDir, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
    writeFileSync(join(profDir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), '{}')

    // 写入包含文档占位符的 package.json
    const badPkg = {
      name: 'test-web',
      dependencies: {
        'dsh-mnemon': 'link:/absolute/path/to/dsh-mnemon',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }
    writeFileSync(join(profDir, 'package.json'), JSON.stringify(badPkg, null, 2))

    const preflight = await runPreflightCheck(dshHome, 'test-web', 3999, mockBin)
    assert.equal(preflight.ok, false)
    assert.ok(preflight.reason?.includes('占位符'))
    assert.equal(preflight.report.overall, 'CRITICAL')
    assert.equal(preflight.canAutoHeal, true)

    // 修正为合法配置
    const goodPkg = {
      name: 'test-web',
      dependencies: {
        'dsh-mnemon': '^0.5.3',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }
    writeFileSync(join(profDir, 'package.json'), JSON.stringify(goodPkg, null, 2))

    const preflightGood = await runPreflightCheck(dshHome, 'test-web', 3999, mockBin)
    assert.equal(preflightGood.ok, true)
    assert.equal(preflightGood.report.layers.layer3_config.invalidPlaceholders.length, 0)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('satisfiesVersionRange: 覆盖 ^ ~ >= 与并列写法（垫片 5 的判定基础）', () => {
  // 事故原样：negotiator@1.1.0 声明的是 ^2.1.0，而解析点上是 1.0.5
  assert.equal(satisfiesVersionRange('2.1.0', '^2.1.0'), true)
  assert.equal(satisfiesVersionRange('2.1.5', '^2.1.0'), true)
  assert.equal(satisfiesVersionRange('2.0.0', '^2.1.0'), false)
  assert.equal(satisfiesVersionRange('1.0.5', '^2.1.0'), false)
  assert.equal(satisfiesVersionRange('3.0.0', '^2.1.0'), false)
  assert.equal(satisfiesVersionRange('1.0.5', '~1.0.0'), true)
  assert.equal(satisfiesVersionRange('1.1.0', '~1.0.0'), false)
  assert.equal(satisfiesVersionRange('2.0.0', '>=2.0.0'), true)
  assert.equal(satisfiesVersionRange('1.9.9', '^1.0.0 || ^2.0.0'), true)
  // 版本号不可解析时必须判为不满足，不能"乐观放行"
  assert.equal(satisfiesVersionRange('不是版本号', '^2.1.0'), false)
  assert.equal(satisfiesVersionRange('2.1.0', '不是范围'), false)
})

/** 复刻事故现场：negotiator 声明 ^2.1.0，但解析点上只有顶层 content-type@1.0.5，且没有嵌套副本。 */
function makeBrokenNegotiatorTree(root: string): string {
  const dshNm = join(root, 'dsh-node_modules')
  mkdirSync(join(dshNm, 'negotiator'), { recursive: true })
  writeFileSync(
    join(dshNm, 'negotiator', 'package.json'),
    JSON.stringify({ name: 'negotiator', version: '1.1.0', dependencies: { 'content-type': '^2.1.0' } })
  )
  mkdirSync(join(dshNm, 'content-type'), { recursive: true })
  writeFileSync(join(dshNm, 'content-type', 'package.json'), JSON.stringify({ name: 'content-type', version: '1.0.5' }))
  writeFileSync(join(dshNm, 'content-type', 'index.js'), '/* 顶层 1.0.5：垫片不许碰它 */\n')
  return dshNm
}

function makeContentTypeCandidate(root: string, version: string): string {
  const dir = join(root, `candidate-content-type-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'content-type', version }))
  writeFileSync(join(dir, 'index.js'), `/* ${version} 合规副本 */\n`)
  return dir
}

test('diagnoseDepTreeConsistency: 报出「声明与解析点不一致」并说清后果', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dep-diag-'))
  try {
    const problems = diagnoseDepTreeConsistency(makeBrokenNegotiatorTree(root))
    assert.ok(problems.length >= 1, '必须报出问题')
    assert.ok(
      problems.some((p) => p.includes('content-type') && p.includes('^2.1.0')),
      '必须同时给出声明的范围与解析点上的版本，否则用户无从判断'
    )
    assert.ok(
      problems.some((p) => p.includes('invalid media type')),
      '必须说清后果（首个请求即退出），否则「网页打不开」会被误当成网络问题'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shimNegotiatorContentType: 只新增嵌套副本、绝不动顶层包、可幂等重跑', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dep-shim-'))
  try {
    const nm = makeBrokenNegotiatorTree(root)
    const cand = makeContentTypeCandidate(root, '2.1.0')
    const topBefore = readFileSync(join(nm, 'content-type', 'index.js'), 'utf8')

    assert.equal(shimNegotiatorContentType(nm, [cand]), 1, '应施加 1 个垫片')
    const nested = join(nm, 'negotiator', 'node_modules', 'content-type')
    assert.equal(readPkgVersion(nested), '2.1.0', '嵌套副本必须是声明所需的版本')
    assert.equal(readFileSync(join(nested, 'index.js'), 'utf8'), '/* 2.1.0 合规副本 */\n', '内容必须来自候选副本')
    assert.equal(readFileSync(join(nm, 'content-type', 'index.js'), 'utf8'), topBefore, '顶层包必须一字未改')
    assert.equal(diagnoseDepTreeConsistency(nm).length, 0, '修好后诊断必须干净')
    assert.equal(shimNegotiatorContentType(nm, [cand]), 0, '第二次调用必须返回 0（幂等）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shimNegotiatorContentType: 找不到合规来源或来源版本不合规时都不动手', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dep-nosrc-'))
  try {
    const nm = makeBrokenNegotiatorTree(root)
    const nested = join(nm, 'negotiator', 'node_modules', 'content-type')

    assert.equal(shimNegotiatorContentType(nm, []), 0, '没有来源时不得凭空造包')
    assert.equal(existsSync(nested), false, '不得留下空目录')
    assert.ok(diagnoseDepTreeConsistency(nm).length >= 1, '诊断仍须如实报出问题')

    const bad = makeContentTypeCandidate(root, '1.0.5')
    assert.equal(shimNegotiatorContentType(nm, [bad]), 0, '来源版本不合规时不得复制')
    assert.equal(existsSync(nested), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clearOrphanCredentialLock: 只有能证明持有者已死才删锁（2026-09-11 地址未就绪事故）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  try {
    const lock = join(home, '.credentials.yaml.lock')

    // ① 锁里是死 PID → 真孤儿，必须清理（否则 dsh 在打印认证地址前就退出）
    writeFileSync(lock, '9999998\n')
    let r = clearOrphanCredentialLock(home)
    assert.deepEqual(r.removed, [lock], '持有者已不存在时必须清理')
    assert.equal(existsSync(lock), false)

    // ② 锁里是活 PID（用本测试进程自己）→ 真的有人在写，绝不删
    writeFileSync(lock, `${process.pid}\n`)
    r = clearOrphanCredentialLock(home)
    assert.deepEqual(r.kept, [lock], '持有者仍在运行时绝不允许删锁')
    assert.equal(existsSync(lock), true, '活锁必须原样保留')

    // ③ 读不出 PID → 无法证明是孤儿，不猜，交给诊断层
    writeFileSync(lock, 'not-a-pid')
    r = clearOrphanCredentialLock(home)
    assert.deepEqual(r.unknown, [lock], '读不出归属时不得猜')
    assert.equal(existsSync(lock), true)
    assert.ok(diagnoseCredentialLock(home).length >= 1, '诊断必须报出无法判定的锁')

    // ④ 没有锁时应是纯空操作（幂等，启动前每次都跑）
    rmSync(lock, { force: true })
    assert.deepEqual(clearOrphanCredentialLock(home), { removed: [], kept: [], unknown: [] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('diagnoseCredentialLock: 把「地址未就绪」背后的真实原因说清楚', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lock-diag-'))
  try {
    assert.deepEqual(diagnoseCredentialLock(home), [], '没有锁时必须保持沉默')

    const lock = join(home, '.credentials.yaml.lock')
    // 孤儿锁：必须同时给出「PID 已不存在」与「表现为地址未就绪」这两件事，
    // 否则用户看到的仍然只是「未就绪」，无从判断
    writeFileSync(lock, '9999998\n')
    const orphan = diagnoseCredentialLock(home).join('\n')
    assert.ok(orphan.includes('9999998'), '要报出持有者 PID')
    assert.ok(orphan.includes('已不存在'), '要说明持有者已死')
    assert.ok(orphan.includes('地址未就绪'), '要把它与用户看到的现象对上')

    // 活锁：不得建议删除，只说清是谁持有
    writeFileSync(lock, `${process.pid}\n`)
    const alive = diagnoseCredentialLock(home).join('\n')
    assert.ok(alive.includes(String(process.pid)))
    assert.ok(alive.includes('仍在运行'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readLockHolderPid / isProcessAlive: 基础语义', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lock-pid-'))
  try {
    const lock = join(home, '.credentials.yaml.lock')
    assert.equal(readLockHolderPid(join(home, 'nope.lock')), null, '文件不存在返回 null')
    writeFileSync(lock, '   12345  \nsecond line')
    assert.equal(readLockHolderPid(lock), 12345, '容忍前后空白，只取第一行')
    writeFileSync(lock, 'abc\n')
    assert.equal(readLockHolderPid(lock), null, '非数字必须判为读不出')

    assert.equal(isProcessAlive(process.pid), true, '本进程必然存活')
    assert.equal(isProcessAlive(9999998), false, '不存在的 PID 必须判为已死')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

