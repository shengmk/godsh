import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, lstatSync, realpathSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { VaultManager } from './vault.js'
import { findUnloadableProfileBundles, describeUnloadableBundles, isLoadableProfileBundle, runPreflightCheck } from '@godsh/core'

/**
 * bug 2 / 3 / 5 的回归测试：vault 写入路径原子化与删除事务化。
 *
 * 这些用例覆盖旧实现的四个具体缺陷：
 *  - 无物理源时仍写入 dependencies/bundles（声明了取不到的包 → 环境打不开）
 *  - 物理源 === 目标目录时把插件包自己删掉（自引用）
 *  - remove 只删索引，不卸挂载、不解除 Junction、不检查反向依赖
 *  - 失败时恒返回 ok:true
 */

interface Fixture {
  tempDir: string
  dataDir: string
  profilesDir: string
  profileDir: string
  storeDir: string
  vm: VaultManager
}

function makeFixture(profileName = 'web-test'): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'godsh-vault-atomic-'))
  const dataDir = join(tempDir, 'data')
  const profilesDir = join(tempDir, 'profiles')
  const storeDir = join(dataDir, 'vault_store')
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(profilesDir, { recursive: true })

  const profileDir = join(profilesDir, profileName)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      { name: `dsh-profile-${profileName}`, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } },
      null,
      2
    ),
    'utf8'
  )

  return { tempDir, dataDir, profilesDir, profileDir, storeDir, vm: new VaultManager(dataDir) }
}

/**
 * 在沙箱池里造一个物理插件包。
 *
 * `bundlePatch` 默认 `'cordis.patch.yml'`：`addFromMarket` 一律把条目标成 `kind:'bundle'`，
 * 因此「池里的包」默认就要按真实 bundle 造（声明 `dsh.bundle.patch`），否则用例断言的
 * 就不是真实 bundle 的行为。造「能解析但不是 bundle」的假包时显式传 `{ bundlePatch: null }`。
 */
function seedStore(
  fx: Fixture,
  name: string,
  version: string,
  extraDeps: Record<string, string> = {},
  opts: { bundlePatch?: string | null; bundlePatchContent?: string } = {}
): string {
  const sanitized = name.replace(/[^a-zA-Z0-9@._-]/g, '_')
  const dir = join(fx.storeDir, `${sanitized}@${version}`)
  mkdirSync(dir, { recursive: true })
  const bundlePatch = opts.bundlePatch === undefined ? 'cordis.patch.yml' : opts.bundlePatch
  const manifest: Record<string, unknown> = { name, version, dependencies: extraDeps }
  if (bundlePatch !== null) {
    manifest.dsh = { bundle: { patch: bundlePatch } }
    // 与真实 bundle 一样落一份 patch 文件：dsh 装载时会读它，缺了会以另一条错误失败
    writeFileSync(join(dir, bundlePatch), opts.bundlePatchContent ?? '[]\n', 'utf8')
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function readProfilePkg(fx: Fixture): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } {
  return JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8'))
}

function idOf(fx: Fixture, name: string): string {
  const p = fx.vm.list().find((x) => x.name === name)
  assert.ok(p, `沙箱中应存在插件 ${name}`)
  return p.id
}

/* ------------------------------------------------------------------ */
/* bug 2：注入原子性                                                     */
/* ------------------------------------------------------------------ */

test('bug2: 无物理源时必须拒绝注入，且不得写入任何声明（旧实现会写 bundles）', async () => {
  const fx = makeFixture()
  try {
    // 只登记元数据，不落物理包（模拟市场暂存后从未下载）
    await fx.vm.addFromMarket({ name: 'ghost-plugin', version: '1.0.0', description: '无物理源' })
    const before = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')

    const r = await fx.vm.deployToProfile('vault-market-ghost-plugin', 'web-test', fx.profilesDir)

    assert.equal(r.ok, false, '无物理源必须失败')
    assert.match(r.error ?? '', /物理源/)

    const after = readProfilePkg(fx)
    assert.equal(after.dependencies?.['ghost-plugin'], undefined, '不得声明取不到的依赖')
    assert.ok(!(after.dsh?.profile?.bundles ?? []).includes('ghost-plugin'), '不得把取不到的包写进 bundles')
    // package.json 必须仍是合法 JSON 且内容未被改动
    assert.equal(readFileSync(join(fx.profileDir, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug2: 自引用（sourcePath 指向目标环境自身）必须被拒绝，且不得删掉物理源', async () => {
  const fx = makeFixture()
  try {
    // 造一个「物理源就在目标 profile 的 node_modules 里」的记录（运行态实测有 26 条这种脏数据）
    const inProfileDir = join(fx.profileDir, 'node_modules', 'selfref-plugin')
    mkdirSync(inProfileDir, { recursive: true })
    writeFileSync(join(inProfileDir, 'package.json'), JSON.stringify({ name: 'selfref-plugin', version: '1.0.0' }), 'utf8')

    await fx.vm.importLocal(inProfileDir, 'local')
    const id = idOf(fx, 'selfref-plugin')

    // 强制 sourcePath 指向目标环境自身
    const vaultJsonPath = join(fx.dataDir, 'vault.json')
    const vaultJson = JSON.parse(readFileSync(vaultJsonPath, 'utf8')) as {
      plugins: { id: string; sourcePath?: string }[]
    }
    const rec = vaultJson.plugins.find((p) => p.id === id)!
    rec.sourcePath = inProfileDir
    writeFileSync(vaultJsonPath, JSON.stringify(vaultJson, null, 2), 'utf8')

    const vm2 = new VaultManager(fx.dataDir)
    const r = await vm2.deployToProfile(id, 'web-test', fx.profilesDir)

    assert.equal(r.ok, false, '自引用必须被拒绝')
    assert.match(r.error ?? '', /自身/)
    // 关键：旧的 createJunctionOrCopy 会先 removePathSafe(dest) 把源目录删掉
    assert.ok(existsSync(join(inProfileDir, 'package.json')), '物理源不得被删除')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug2: 正常注入应成功，并同时落好 dependencies / bundles / node_modules', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'ok-plugin', '1.0.0')
    await fx.vm.addFromMarket({ name: 'ok-plugin', version: '1.0.0' })

    const r = await fx.vm.deployToProfile('vault-market-ok-plugin', 'web-test', fx.profilesDir)

    assert.equal(r.ok, true)
    assert.ok(r.deployed.includes('ok-plugin'))
    const pkg = readProfilePkg(fx)
    assert.ok(pkg.dependencies?.['ok-plugin'], '必须有依赖声明')
    assert.ok(existsSync(join(fx.profileDir, 'node_modules', 'ok-plugin', 'package.json')), '必须物理可解析')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* bug 3 / 5：删除的事务化与反向依赖保护                                    */
/* ------------------------------------------------------------------ */

test('bug3: 被依赖的伴随插件默认拒绝删除，并给出依赖者清单', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'dsh-web-search-pro', '0.1.11')
    seedStore(fx, '@anweat/dsh-browser', '0.1.10')
    await fx.vm.addFromMarket({ name: 'dsh-web-search-pro', version: '0.1.11' })
    await fx.vm.addFromMarket({ name: '@anweat/dsh-browser', version: '0.1.10' })

    const deploy = await fx.vm.deployToProfile('vault-market-dsh-web-search-pro', 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)

    const companionId = idOf(fx, '@anweat/dsh-browser')
    const r = await fx.vm.remove(companionId, { profilesDir: fx.profilesDir })

    assert.equal(r.ok, false, 'block 模式应拒绝删除被依赖的伴随插件')
    assert.ok(r.dependents.includes('dsh-web-search-pro'), `依赖者清单应含父插件，实际: ${r.dependents.join(',')}`)
    // 环境必须仍然完好
    assert.ok(existsSync(join(fx.profileDir, 'node_modules', '@anweat', 'dsh-browser', 'package.json')))
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug5: 删除是完整事务——解除挂载 + 清理声明 + 移除索引', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'solo-plugin', '2.0.0')
    await fx.vm.addFromMarket({ name: 'solo-plugin', version: '2.0.0' })
    const deploy = await fx.vm.deployToProfile('vault-market-solo-plugin', 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)

    const id = idOf(fx, 'solo-plugin')
    const r = await fx.vm.remove(id, { profilesDir: fx.profilesDir })

    assert.equal(r.ok, true)
    assert.ok(r.unmountedFrom.includes('web-test'), '应记录从哪个环境卸载')

    const pkg = readProfilePkg(fx)
    assert.equal(pkg.dependencies?.['solo-plugin'], undefined, '依赖声明必须被清理')
    assert.ok(
      !(pkg.dsh?.profile?.bundles ?? []).includes('solo-plugin'),
      'bundles 声明必须被清理（旧实现会留下悬空 bundle → 环境打不开）'
    )
    assert.ok(!existsSync(join(fx.profileDir, 'node_modules', 'solo-plugin')), 'Junction 必须被解除')
    assert.ok(!fx.vm.list().some((p) => p.name === 'solo-plugin'), '索引必须被移除')
    // purge 默认 false：物理池保留，交给 GC
    assert.ok(existsSync(join(fx.storeDir, 'solo-plugin@2.0.0')), '默认不删除物理池目录')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug5: purge=true 时回收物理池目录', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'purge-me', '1.0.0')
    await fx.vm.addFromMarket({ name: 'purge-me', version: '1.0.0' })
    const id = idOf(fx, 'purge-me')
    const r = await fx.vm.remove(id, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(r.ok, true)
    assert.equal(r.purged, true)
    assert.ok(!existsSync(join(fx.storeDir, 'purge-me@1.0.0')), '物理目录应被回收')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug5: 删除不存在的插件返回失败（旧路由会返回 200 ok:true）', async () => {
  const fx = makeFixture()
  try {
    const r = await fx.vm.remove('does-not-exist')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /未找到/)
    assert.deepEqual(r.dependents, [])
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('bug5: 批量删除逐项独立，单项失败不影响其余', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'batch-a', '1.0.0')
    seedStore(fx, 'batch-b', '1.0.0')
    await fx.vm.addFromMarket({ name: 'batch-a', version: '1.0.0' })
    await fx.vm.addFromMarket({ name: 'batch-b', version: '1.0.0' })

    const aId = idOf(fx, 'batch-a')
    const bId = idOf(fx, 'batch-b')
    const r = await fx.vm.removeMany([aId, bId, 'ghost-id'], { profilesDir: fx.profilesDir })

    assert.equal(r.removed, 2)
    assert.equal(r.failed, 1)
    assert.equal(r.results.length, 3)
    assert.equal(r.results.find((x) => x.id === 'ghost-id')?.status, 'failed')
    assert.equal(r.results.find((x) => x.id === aId)?.status, 'removed')
    assert.ok(!fx.vm.list().some((p) => p.name === 'batch-a'))
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 未完成项收尾：GC 死链防护 / 子依赖推导 / 收割不纳管子插件                    */
/* ------------------------------------------------------------------ */

test('收尾: GC 不删除仍被 Profile 链接的池目录（防止制造死链）', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'linked-plugin', '1.0.0')
    await fx.vm.addFromMarket({ name: 'linked-plugin', version: '1.0.0' })
    const id = idOf(fx, 'linked-plugin')
    const deploy = await fx.vm.deployToProfile(id, 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)
    const storeDirPath = join(fx.storeDir, 'linked-plugin@1.0.0')
    assert.ok(existsSync(storeDirPath))

    // 复现旧 remove 的坏状态：只从索引删记录、不解挂载（profile 仍链着池目录）
    const vaultJsonPath = join(fx.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vaultJsonPath, 'utf8')) as { plugins: { id: string }[] }
    vj.plugins = vj.plugins.filter((p) => p.id !== id)
    writeFileSync(vaultJsonPath, JSON.stringify(vj, null, 2), 'utf8')

    const vm2 = new VaultManager(fx.dataDir)
    const gc = await vm2.garbageCollect(fx.profilesDir)

    assert.ok(
      gc.keptDirs.includes('linked-plugin@1.0.0'),
      `仍被环境链接的池目录必须保留，实际 kept=[${gc.keptDirs.join(',')}] removed=[${gc.removedDirs.join(',')}]`
    )
    assert.ok(!gc.removedDirs.includes('linked-plugin@1.0.0'))
    assert.ok(existsSync(storeDirPath), '池目录必须仍在')
    // 关键：环境的 junction 没有被变成死链
    assert.ok(existsSync(join(fx.profileDir, 'node_modules', 'linked-plugin', 'package.json')))
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('收尾: 注入父插件时自动带上沙箱内的子依赖（契约表未覆盖的依赖边）', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'dsh-child-dep', '1.0.0')
    seedStore(fx, 'dsh-parent-plugin', '1.0.0', { 'dsh-child-dep': '^1.0.0' })
    await fx.vm.addFromMarket({ name: 'dsh-child-dep', version: '1.0.0' })
    await fx.vm.addFromMarket({ name: 'dsh-parent-plugin', version: '1.0.0' })

    const parentId = idOf(fx, 'dsh-parent-plugin')
    const r = await fx.vm.deployToProfile(parentId, 'web-test', fx.profilesDir)

    assert.equal(r.ok, true)
    assert.ok(
      r.derivedCompanions?.includes('dsh-child-dep'),
      `应从父插件 package.json 推导出子依赖，实际 derived=[${(r.derivedCompanions ?? []).join(',')}]`
    )
    const pkg = readProfilePkg(fx)
    assert.ok(pkg.dependencies?.['dsh-child-dep'], '子依赖必须写入 dependencies')
    assert.ok(
      existsSync(join(fx.profileDir, 'node_modules', 'dsh-child-dep', 'package.json')),
      '子依赖必须物理可解析（否则插件树不完整 → 环境打不开）'
    )
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('收尾: 收割不把「别人的子依赖」纳管为独立条目（防止删除后复活）', async () => {
  const fx = makeFixture()
  try {
    const nm = join(fx.profileDir, 'node_modules')
    const parentDir = join(nm, 'dsh-harvest-parent')
    const childDir = join(nm, 'dsh-harvest-child')
    mkdirSync(parentDir, { recursive: true })
    mkdirSync(childDir, { recursive: true })
    writeFileSync(
      join(parentDir, 'package.json'),
      JSON.stringify({ name: 'dsh-harvest-parent', version: '1.0.0', dependencies: { 'dsh-harvest-child': '^1.0.0' } }),
      'utf8'
    )
    writeFileSync(
      join(childDir, 'package.json'),
      JSON.stringify({ name: 'dsh-harvest-child', version: '1.0.0' }),
      'utf8'
    )

    const res = await fx.vm.harvestFromProfiles(fx.profilesDir)
    const names = res.harvested.map((p) => p.name)

    assert.ok(names.includes('dsh-harvest-parent'), `父插件应被收割，实际=[${names.join(',')}]`)
    assert.ok(!names.includes('dsh-harvest-child'), '子插件不应被单独纳管（否则删除后会以新 id 复活）')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 第三条规则：共同占有的子依赖按父复制，删一个父不能动另一个父                 */
/* ------------------------------------------------------------------ */

/** 造出「两个父插件共同声明同一个子依赖」的沙箱前置状态。 */
async function seedSharedDependency(
  fx: Fixture,
  childName: string,
  childVersion: string,
  parentA: string,
  parentB: string
): Promise<{ aId: string; bId: string }> {
  seedStore(fx, childName, childVersion)
  seedStore(fx, parentA, '1.0.0', { [childName]: `^${childVersion}` })
  seedStore(fx, parentB, '1.0.0', { [childName]: `^${childVersion}` })
  await fx.vm.addFromMarket({ name: childName, version: childVersion })
  await fx.vm.addFromMarket({ name: parentA, version: '1.0.0' })
  await fx.vm.addFromMarket({ name: parentB, version: '1.0.0' })
  return { aId: idOf(fx, parentA), bId: idOf(fx, parentB) }
}

/**
 * 断言路径是一个**真实可解析**的包目录。
 *
 * 为什么不用 `existsSync`：它只回答「这个路径能不能 stat 到」，给不出真实目标，
 * 而 realpath 是唯一无歧义的口径（链接断掉时直接抛 ENOENT）。
 * 说明：审查者报告的「Windows 上 existsSync 对 junction 死链仍返回 true」在本机
 * Node v25.8.0 未能复现（实测 existsSync(link/pkg.json) === false、realpath 抛 ENOENT），
 * 但 lstat → realpath → 真读文件这套写法在两种行为下都成立，因此不受该分歧影响。
 */
function assertResolvablePackage(dirPath: string, msg: string): void {
  const st = lstatSync(dirPath) // 路径不存在会直接抛错 → 用例失败
  const real = st.isSymbolicLink() ? realpathSync(dirPath) : dirPath // 死链在此抛 ENOENT
  const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { name?: string }
  assert.ok(manifest.name, msg)
}

/** 断言路径**确实不存在**（用 lstat 而不是 existsSync，语义明确、不受死链影响）。 */
function assertPathMissing(p: string, msg: string): void {
  let present = true
  try {
    lstatSync(p)
  } catch {
    present = false
  }
  assert.equal(present, false, msg)
}

/** 断言 profile 里某个包的链接**正好**指向给定目录（断链、指错、被复制替换都会失败）。 */
function assertProfileLinkedTo(fx: Fixture, name: string, wantDir: string, msg: string): void {
  const p = join(fx.profileDir, 'node_modules', ...name.split('/'))
  const st = lstatSync(p) // 链接不存在 → 直接失败
  assert.ok(st.isSymbolicLink(), `${name} 应当是指向沙箱副本的链接（${msg}）`)
  assert.equal(
    resolve(realpathSync(p)).toLowerCase(),
    resolve(wantDir).toLowerCase(),
    `${name} 的链接目标不对（${msg}）`
  )
}

test('第三条规则: 两个父插件共用同一子依赖时，各得一份按父隔离的独立副本', async () => {
  const fx = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')

    const bundled = await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])
    assert.deepEqual(bundled, ['shared-lib'], '应上报本次归并/新建的子插件名')

    const children = fx.vm.list().filter((p) => p.name === 'shared-lib')
    assert.equal(children.length, 2, `共同占有必须为每个父各留一份副本，实际=${children.length}`)

    const forAlpha = children.find((c) => c.parentId === aId)
    const forBeta = children.find((c) => c.parentId === bId)
    assert.ok(forAlpha && forBeta, `两份副本必须各归其父，实际=[${children.map((c) => c.parentId).join(',')}]`)
    assert.equal(forAlpha.childOrigin, 'shared-copy')
    assert.equal(forBeta.childOrigin, 'shared-copy')
    assert.notEqual(forAlpha.sourcePath, forBeta.sourcePath, '两份副本的物理目录必须不同（按父隔离）')
    assertResolvablePackage(forAlpha.sourcePath!, 'alpha 的副本必须是真实可解析的包目录')
    assertResolvablePackage(forBeta.sourcePath!, 'beta 的副本必须是真实可解析的包目录')
    // 目录名必须把父名编进去，否则两个父仍会指向同一个物理目录
    assertResolvablePackage(join(fx.storeDir, 'parent-alpha__shared-lib@1.0.0'), 'alpha 的按父隔离目录必须存在且可解析')
    assertResolvablePackage(join(fx.storeDir, 'parent-beta__shared-lib@1.0.0'), 'beta 的按父隔离目录必须存在且可解析')

    // 池里那份「公共根条目」必须被摘掉，否则它仍以独立插件身份占着列表（列表被淹没的老现象）
    assert.ok(
      !fx.vm.list().some((p) => p.name === 'shared-lib' && !p.parentId),
      '共同占有后不应再有 parentId 为空的公共条目'
    )
    assert.deepEqual(fx.vm.get(aId)?.bundledDeps, ['shared-lib'], '父插件应记下自己捆绑了哪些子依赖')
    assert.deepEqual(fx.vm.get(bId)?.bundledDeps, ['shared-lib'])

    // 幂等：重复归并不再复制（否则每次注入都会多占一份磁盘）
    assert.deepEqual(await fx.vm.bundleChildrenForParent(aId, ['shared-lib']), [])
    assert.equal(fx.vm.list().filter((p) => p.name === 'shared-lib').length, 2)

    // 两个父都能各自注入，且注入的是自己那份副本
    const deploy = await fx.vm.deployToProfile(aId, 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)
    assert.ok(deploy.derivedCompanions?.includes('shared-lib'))
    assertProfileLinkedTo(fx, 'shared-lib', forAlpha.sourcePath!, '注入的必须是该父自己那份副本')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('第三条规则: 删除一个父只回收它名下的子副本，另一个父的子副本完好可用', async () => {
  const fx = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])

    const betaDir = fx.vm.list().find((p) => p.parentId === bId && p.name === 'shared-lib')!.sourcePath!
    assertResolvablePackage(betaDir, 'beta 的副本必须先是真实可解析的包目录')

    const r = await fx.vm.remove(aId, { profilesDir: fx.profilesDir })
    assert.equal(r.ok, true)

    // 父自身与它名下的子副本条目都必须消失
    assert.ok(!fx.vm.list().some((p) => p.id === aId), '父条目必须被移除')
    assert.ok(!fx.vm.list().some((p) => p.parentId === aId), '该父名下的子副本条目必须被回收')
    // 关键验收点：另一个父的子副本条目与物理文件毫发无损
    const betaChild = fx.vm.list().find((p) => p.parentId === bId && p.name === 'shared-lib')
    assert.ok(betaChild, '另一个父的子副本条目不得被删除')
    assert.equal(betaChild.sourcePath, betaDir, '另一个父的子副本物理路径不得改变')
    assertResolvablePackage(betaDir, '另一个父的子副本物理文件必须完好')

    // 而且它依然能正常解析 / 注入（环境不会因缺依赖打不开）
    const deploy = await fx.vm.deployToProfile(bId, 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)
    assert.ok(deploy.derivedCompanions?.includes('shared-lib'))
    assertProfileLinkedTo(fx, 'shared-lib', betaDir, '删掉 alpha 后 beta 必须注入自己那份副本')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义6: GC 与单独删除一视同仁（根在不回收 / 根不在且无例外则回收 / 满足例外则转正保留）', async () => {
  // ---- 状态①：根还在 → 子副本不得被 GC 回收 ----
  const keep = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(keep, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await keep.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaChild = keep.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    // 注入到环境：组合整体进环境（根 + 子副本链接都在）
    const deploy = await keep.vm.deployToProfile(aId, 'web-test', keep.profilesDir)
    assert.equal(deploy.ok, true)

    const gcKeep = await keep.vm.garbageCollect(keep.profilesDir)
    assert.ok(
      !gcKeep.removedDirs.includes(basename(alphaChild.sourcePath!)),
      `根还在的子副本不得被 GC 回收，实际 removed=[${gcKeep.removedDirs.join(',')}]`
    )
    assert.ok(keep.vm.list().some((p) => p.id === alphaChild.id), '根还在时子副本条目必须保留')
    assert.ok(keep.vm.list().some((p) => p.id === bId), '另一个组合的根也必须保留')
    assertResolvablePackage(alphaChild.sourcePath!, '根还在时子副本物理目录必须完好')
  } finally {
    rmSync(keep.tempDir, { recursive: true, force: true })
  }

  // ---- 状态②：根不在、也没人依赖它 → 索引条目与物理目录一并回收 ----
  const drop = makeFixture()
  try {
    const { aId } = await seedSharedDependency(drop, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await drop.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaChild = drop.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    const betaChild = drop.vm.list().find((p) => p.name === 'shared-lib' && p.parentId !== aId)!
    const alphaDir = alphaChild.sourcePath!

    // 复现「根条目被删掉、子副本记录还留着」的坏状态（旧实现就会留下这种幽灵条目）
    const vjPath = join(drop.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vjPath, 'utf8')) as { plugins: { id: string }[] }
    vj.plugins = vj.plugins.filter((p) => p.id !== aId)
    writeFileSync(vjPath, JSON.stringify(vj, null, 2), 'utf8')

    const gcDrop = await new VaultManager(drop.dataDir).garbageCollect(drop.profilesDir)
    assert.ok(
      gcDrop.removedDirs.includes(basename(alphaDir)),
      `根已不存在且无人依赖的孤儿子副本必须回收，实际 removed=[${gcDrop.removedDirs.join(',')}]`
    )
    assertPathMissing(alphaDir, '孤儿条目对应的物理目录必须被删除')
    const vm2 = new VaultManager(drop.dataDir)
    assert.ok(!vm2.list().some((p) => p.id === alphaChild.id), '孤儿条目的索引必须被一并回收，不留幽灵条目')
    assert.ok(vm2.list().some((p) => p.id === betaChild.id), '别的组合的子副本不得被牵连')
    assertResolvablePackage(betaChild.sourcePath!, '别的组合的子副本物理目录必须完好')
  } finally {
    rmSync(drop.tempDir, { recursive: true, force: true })
  }

  // ---- 状态③：根不在、但该环境仍链着子副本 → 转成根条目保留（幂等） ----
  const promote = makeFixture()
  try {
    const { aId } = await seedSharedDependency(promote, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await promote.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaChild = promote.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    const childDir = alphaChild.sourcePath!
    const childLink = join(promote.profileDir, 'node_modules', 'shared-lib')
    // 环境里只有子副本（根不在这个环境）：直接建链接 + 写声明来构造这个状态
    symlinkSync(childDir, childLink, 'junction')

    const vjPath = join(promote.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vjPath, 'utf8')) as { plugins: { id: string }[] }
    vj.plugins = vj.plugins.filter((p) => p.id !== aId)
    writeFileSync(vjPath, JSON.stringify(vj, null, 2), 'utf8')

    const vm3 = new VaultManager(promote.dataDir)
    const gcPromote = await vm3.garbageCollect(promote.profilesDir)
    assert.ok(
      (gcPromote.promotedRoots ?? []).includes('shared-lib'),
      `满足例外的子副本必须被转正，实际 promoted=[${(gcPromote.promotedRoots ?? []).join(',')}]`
    )
    const promoted = vm3.list().find((p) => p.id === alphaChild.id)
    assert.ok(promoted, '被环境依赖的子副本条目必须保留')
    assert.equal(promoted.parentId, undefined, '父已不存在 → 必须清掉 parentId 转成根条目，否则用户看不见也管不了')
    assert.equal(promoted.childOrigin, undefined, '必须一并清掉 childOrigin')
    assert.deepEqual(promoted.installedProfiles, ['web-test'], '转正后要按正常根条目记账（哪个环境在用它）')
    assertResolvablePackage(childDir, '例外保留的子副本物理目录必须完好')
    assertResolvablePackage(childLink, '环境里的链接必须仍可解析到真实目录（不得是死链）')

    // 幂等：再跑两次 GC，条目不得被反复改写或产生脏数据
    const snapshot = JSON.stringify(vm3.list().find((p) => p.id === alphaChild.id))
    await vm3.garbageCollect(promote.profilesDir)
    const gc2 = await vm3.garbageCollect(promote.profilesDir)
    assert.equal(
      JSON.stringify(vm3.list().find((p) => p.id === alphaChild.id)),
      snapshot,
      '重复 GC 不得反复改写转正后的条目'
    )
    assert.equal(gc2.promotedRoots, undefined, '转正后已是有根条目，不应再次被判定为例外')
    assert.deepEqual(
      vm3.list().filter((p) => p.name === 'shared-lib' && !p.parentId).map((p) => p.id),
      [alphaChild.id],
      '转正后应当**恰好**有一条同名根条目（另一个父的子副本仍挂在自己父名下，不算重复）'
    )
    assertResolvablePackage(childLink, '重复 GC 之后环境里的依赖仍必须可解析')
  } finally {
    rmSync(promote.tempDir, { recursive: true, force: true })
  }
})

test('第三条规则: 只被一个父引用时归为 standalone，不复制、不膨胀', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'solo-child', '1.0.0')
    seedStore(fx, 'solo-parent', '1.0.0', { 'solo-child': '^1.0.0' })
    await fx.vm.addFromMarket({ name: 'solo-child', version: '1.0.0' })
    await fx.vm.addFromMarket({ name: 'solo-parent', version: '1.0.0' })
    const parentId = idOf(fx, 'solo-parent')

    const bundled = await fx.vm.bundleChildrenForParent(parentId, ['solo-child'])
    assert.deepEqual(bundled, ['solo-child'])

    const entries = fx.vm.list().filter((p) => p.name === 'solo-child')
    assert.equal(entries.length, 1, `唯一父不得触发复制，否则每归并一次就膨胀一份，实际=${entries.length}`)
    const child = entries[0]!
    assert.equal(child.parentId, parentId)
    assert.equal(child.childOrigin, 'standalone')
    assert.equal(
      resolve(child.sourcePath!),
      resolve(join(fx.storeDir, 'solo-child@1.0.0')),
      'standalone 直接复用池里那份，不得新建任何目录'
    )
    assertPathMissing(join(fx.storeDir, 'solo-parent__solo-child@1.0.0'), '不得出现按父命名的副本目录')

    // 幂等
    assert.deepEqual(await fx.vm.bundleChildrenForParent(parentId, ['solo-child']), [])
    assert.equal(fx.vm.list().filter((p) => p.name === 'solo-child').length, 1)

    // 注入依旧带上它（既有语义未被破坏）
    const deploy = await fx.vm.deployToProfile(parentId, 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)
    assert.ok(deploy.derivedCompanions?.includes('solo-child'))
    assertResolvablePackage(join(fx.profileDir, 'node_modules', 'solo-child'), 'standalone 子依赖必须物理可解析')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('第三条规则: 迁移函数把历史遗留的公共共享条目拆成按父副本（空沙箱时为空操作）', async () => {
  // 当前真实沙箱是空的 → 迁移必须是纯空操作，不能因为「没数据」就报错
  const empty = makeFixture()
  try {
    assert.deepEqual(
      await empty.vm.migrateSharedChildren(),
      { scanned: 0, bundled: [] },
      '空沙箱迁移必须是空操作'
    )
  } finally {
    rmSync(empty.tempDir, { recursive: true, force: true })
  }

  const fx = makeFixture()
  try {
    // 复现升级前的结构：共享子依赖仍是一条 parentId 为空的公共根条目，被两个父声明
    const { aId, bId } = await seedSharedDependency(fx, 'legacy-shared', '2.1.0', 'legacy-parent-a', 'legacy-parent-b')
    assert.ok(
      fx.vm.list().some((p) => p.name === 'legacy-shared' && !p.parentId),
      '迁移前它应当是 parentId 为空的公共条目'
    )

    const res = await fx.vm.migrateSharedChildren()
    assert.equal(res.scanned, 3, '应扫描到 3 条根条目（子依赖 + 两个父）')
    assert.ok(res.bundled.includes('legacy-shared'), `实际 bundled=[${res.bundled.join(',')}]`)

    const children = fx.vm.list().filter((p) => p.name === 'legacy-shared')
    assert.equal(children.length, 2, '共同占有的历史条目应被拆成两份')
    assert.deepEqual(children.map((c) => c.childOrigin), ['shared-copy', 'shared-copy'])
    assert.deepEqual([...children.map((c) => c.parentId)].sort(), [aId, bId].sort())
    assertResolvablePackage(join(fx.storeDir, 'legacy-parent-a__legacy-shared@2.1.0'), '迁移必须为 a 复制出真实可解析的副本')
    assertResolvablePackage(join(fx.storeDir, 'legacy-parent-b__legacy-shared@2.1.0'), '迁移必须为 b 复制出真实可解析的副本')

    // 幂等：已经是新结构时再跑一次不再产生任何新条目
    assert.deepEqual(await fx.vm.migrateSharedChildren(), { scanned: 2, bundled: [] })
    assert.equal(fx.vm.list().filter((p) => p.name === 'legacy-shared').length, 2)
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 对抗性复核的修复回归：I1（死链）/ I1b（purge 保护）/ I2（按名命中）/ I5（谎报环境） */
/* ------------------------------------------------------------------ */

test('I1: 同一环境里第二个父必须接管依赖链接，删掉第一个父不得留下死链', async () => {
  const fx = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaDir = fx.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!.sourcePath!
    const betaDir = fx.vm.list().find((p) => p.parentId === bId && p.name === 'shared-lib')!.sourcePath!
    const depLink = join(fx.profileDir, 'node_modules', 'shared-lib')

    // ① 先注入父 A
    const deployA = await fx.vm.deployToProfile(aId, 'web-test', fx.profilesDir)
    assert.equal(deployA.ok, true)
    assertProfileLinkedTo(fx, 'shared-lib', alphaDir, 'A 注入后应先指向 A 自己的副本')

    // ② 同一个环境里再注入父 B（此时 A 尚未删除）
    const deployB = await fx.vm.deployToProfile(bId, 'web-test', fx.profilesDir)
    assert.equal(deployB.ok, true)
    assert.ok(
      deployB.derivedCompanions?.includes('shared-lib'),
      `第二个父必须把该依赖接管到自己那份副本上（旧实现此处早退 derived=[]），实际=[${(deployB.derivedCompanions ?? []).join(',')}]`
    )
    assertProfileLinkedTo(fx, 'shared-lib', betaDir, '第二个父必须把依赖重指到自己那份副本')

    // ③ 删掉父 A（含物理回收）
    const removed = await fx.vm.remove(aId, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(removed.ok, true)

    // 不得出现「lstat 仍是 symlink、realpath 报 ENOENT」的死链：那种状态下 package.json 里
    // 该依赖的声明还在，dsh 解析不到 → 环境打不开
    assertResolvablePackage(depLink, '删掉 A 之后依赖必须仍解析到真实存在的包（不得是死链）')
    assertProfileLinkedTo(fx, 'shared-lib', betaDir, '删掉 A 之后链接仍应指向 B 的副本')
    assertResolvablePackage(betaDir, 'B 的副本物理文件必须完好')
    const pkg = readProfilePkg(fx)
    assert.ok(pkg.dependencies?.['shared-lib'], 'profile 里该依赖的声明必须仍然成立')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义1: 删母即删子——子副本条目与物理目录一并消失，环境不留死链与悬空声明', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'owned-child', '1.0.0')
    seedStore(fx, 'only-parent', '1.0.0', { 'owned-child': '^1.0.0' })
    await fx.vm.addFromMarket({ name: 'owned-child', version: '1.0.0' })
    await fx.vm.addFromMarket({ name: 'only-parent', version: '1.0.0' })
    const parentId = idOf(fx, 'only-parent')

    const deploy = await fx.vm.deployToProfile(parentId, 'web-test', fx.profilesDir)
    assert.equal(deploy.ok, true)
    const child = fx.vm.list().find((p) => p.parentId === parentId && p.name === 'owned-child')!
    const childDir = child.sourcePath!
    assertProfileLinkedTo(fx, 'owned-child', childDir, '注入后环境应链到该父的子副本')
    const beforePkg = readProfilePkg(fx)
    assert.ok(beforePkg.dependencies?.['owned-child'], '前置：环境里应当声明了这个子依赖')

    const removed = await fx.vm.remove(parentId, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(removed.ok, true)
    assert.equal(removed.purged, true, '组合成员的物理目录都应被回收')
    assert.equal(removed.bundleRootName, 'only-parent')

    // 索引：根与子副本条目全部消失
    assert.ok(!fx.vm.list().some((p) => p.id === parentId), '根条目必须被移除')
    assert.ok(!fx.vm.list().some((p) => p.parentId === parentId), '子副本条目必须被一并移除')
    assert.ok(removed.removedChildren?.includes(child.id), `removedChildren 应报告连带删除的子副本，实际=[${(removed.removedChildren ?? []).join(',')}]`)
    // 物理：两个目录都不在了
    assertPathMissing(join(fx.storeDir, 'only-parent@1.0.0'), '根的池目录应被回收')
    assertPathMissing(childDir, '子副本的物理目录必须被一并回收（删母即删子）')
    // 环境：链接与声明都被清理，不留死链也不留悬空声明
    assertPathMissing(join(fx.profileDir, 'node_modules', 'owned-child'), '环境里该依赖的链接必须被解除')
    const afterPkg = readProfilePkg(fx)
    assert.equal(afterPkg.dependencies?.['owned-child'], undefined, '环境里该依赖的声明必须被清理')
    assert.equal(afterPkg.dependencies?.['only-parent'], undefined, '根自身的声明必须被清理')
    // 环境里的根链接必须被解除，且不得留下任何指向已删目录的链接
    assertPathMissing(join(fx.profileDir, 'node_modules', 'only-parent'), '根在该环境里的链接必须被解除')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义2: 删子即删母——用子副本 id 删除，整个组合（根 + 全部子副本）一起消失', async () => {
  const fx = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaChild = fx.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    const betaChild = fx.vm.list().find((p) => p.parentId === bId && p.name === 'shared-lib')!

    // 用**子副本 id** 删除：删除单位是组合，所以根也一并消失
    const removed = await fx.vm.remove(alphaChild.id, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(removed.ok, true)
    assert.equal(removed.bundleRootName, 'parent-alpha', '删子时必须看出被删的是哪个组合')
    assert.ok(!fx.vm.list().some((p) => p.id === aId), '删子即删母：根条目必须一起消失')
    assert.ok(!fx.vm.list().some((p) => p.parentId === aId), '该组合的全部子副本条目必须消失')
    assertPathMissing(alphaChild.sourcePath!, '该组合的子副本物理目录必须被回收')
    assertPathMissing(join(fx.storeDir, 'parent-alpha@1.0.0'), '该组合的根物理目录必须被回收')

    // 另一个组合必须丝毫未动
    assert.ok(fx.vm.list().some((p) => p.id === bId), '另一个根不得被牵连')
    assert.ok(fx.vm.list().some((p) => p.id === betaChild.id), '另一个组合的子副本条目不得被牵连')
    assertResolvablePackage(betaChild.sourcePath!, '另一个组合的子副本物理目录必须完好')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义3: 子在该环境而母不在 → 删母时该子副本保留并转成根条目（幂等）', async () => {
  const fx = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const alphaChild = fx.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    const betaChild = fx.vm.list().find((p) => p.parentId === bId && p.name === 'shared-lib')!
    const childDir = alphaChild.sourcePath!

    // 构造「环境里只有这个子副本、没有它的根」：直接建链接（不部署 parent-alpha）
    const childLink = join(fx.profileDir, 'node_modules', 'shared-lib')
    symlinkSync(childDir, childLink, 'junction')
    const pkg = readProfilePkg(fx)
    pkg.dependencies = { ...(pkg.dependencies ?? {}), 'shared-lib': '^1.0.0' }
    writeFileSync(join(fx.profileDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const removed = await fx.vm.remove(aId, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(removed.ok, true)

    // 例外：该子副本必须保留，并转成根条目（否则用户看不见也管不了）
    assert.ok(
      removed.preservedChildren?.includes(alphaChild.id),
      `该子副本必须被例外保留，实际 preserved=[${(removed.preservedChildren ?? []).join(',')}]`
    )
    assert.ok(
      !(removed.removedChildren ?? []).includes(alphaChild.id),
      '被例外保留的子副本不得出现在连带删除清单里'
    )
    const promoted = fx.vm.list().find((p) => p.id === alphaChild.id)
    assert.ok(promoted, '被环境依赖的子副本条目必须保留')
    assert.equal(promoted.parentId, undefined, '父已不存在 → 必须清掉 parentId 转成根条目')
    assert.equal(promoted.childOrigin, undefined, '必须一并清掉 childOrigin')
    assert.deepEqual(promoted.installedProfiles, ['web-test'], '转正后按正常根条目记账')
    assert.equal(promoted.bundledDeps?.length ?? 0, 0, '它自己没有子依赖，bundledDeps 应为空清单')

    // 物理与解析：目录保留、环境的依赖仍能解析到真实目录
    assertResolvablePackage(childDir, '例外保留的子副本物理目录必须完好（不得被 purge 删除）')
    assertResolvablePackage(childLink, '环境里的依赖必须仍可解析（realpath，不是 existsSync）')
    // 根确实被删了；另一个组合完好
    assert.ok(!fx.vm.list().some((p) => p.id === aId), '根条目仍必须被删除')
    assertResolvablePackage(betaChild.sourcePath!, '另一个组合的子副本不得被牵连')

    // 幂等：重复 GC 不得反复改写或产生脏数据
    const snapshot = JSON.stringify(fx.vm.list().find((p) => p.id === alphaChild.id))
    await fx.vm.garbageCollect(fx.profilesDir)
    await fx.vm.garbageCollect(fx.profilesDir)
    assert.equal(
      JSON.stringify(fx.vm.list().find((p) => p.id === alphaChild.id)),
      snapshot,
      '重复 GC 不得改写转正后的条目'
    )
    assert.deepEqual(
      fx.vm.list().filter((p) => p.name === 'shared-lib' && !p.parentId).map((p) => p.id),
      [alphaChild.id],
      '转正后应当**恰好**有一条同名根条目（另一个父的子副本仍在自己父名下，不算重复）'
    )
    assertResolvablePackage(childLink, '重复 GC 后环境的依赖仍必须可解析')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义4: 子副本条目或物理源缺失时拒绝注入，绝不让根单独进环境', async () => {
  // ---- 变体 A：子副本的物理源缺失 ----
  const byDir = makeFixture()
  try {
    const { aId } = await seedSharedDependency(byDir, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await byDir.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const childDir = byDir.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!.sourcePath!
    rmSync(childDir, { recursive: true, force: true }) // 物理源没了（条目还在）
    const before = readFileSync(join(byDir.profileDir, 'package.json'), 'utf8')

    const r = await byDir.vm.deployToProfile(aId, 'web-test', byDir.profilesDir)
    assert.equal(r.ok, false, '子副本物理源缺失时注入必须失败')
    assert.match(r.error ?? '', /物理源缺失/, `错误原因必须明确，实际=${r.error}`)
    // 不得把根单独放进环境：声明与链接都不能出现
    assert.equal(readFileSync(join(byDir.profileDir, 'package.json'), 'utf8'), before, '失败时不得写任何声明')
    assertPathMissing(join(byDir.profileDir, 'node_modules', 'parent-alpha'), '不得把根单独链进环境')
  } finally {
    rmSync(byDir.tempDir, { recursive: true, force: true })
  }

  // ---- 变体 B：子副本的条目缺失（账上有、条目没了） ----
  const byEntry = makeFixture()
  try {
    seedStore(byEntry, 'lonely-child', '1.0.0')
    seedStore(byEntry, 'lonely-parent', '1.0.0', { 'lonely-child': '^1.0.0' })
    await byEntry.vm.addFromMarket({ name: 'lonely-child', version: '1.0.0' })
    await byEntry.vm.addFromMarket({ name: 'lonely-parent', version: '1.0.0' })
    const parentId = idOf(byEntry, 'lonely-parent')
    await byEntry.vm.bundleChildrenForParent(parentId, ['lonely-child'])
    const child = byEntry.vm.list().find((p) => p.parentId === parentId && p.name === 'lonely-child')!

    // 抹掉子副本条目（账 bundledDeps 仍在，且沙箱里再无同名包可自愈重建）
    const vjPath = join(byEntry.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vjPath, 'utf8')) as { plugins: { id: string }[] }
    vj.plugins = vj.plugins.filter((p) => p.id !== child.id)
    writeFileSync(vjPath, JSON.stringify(vj, null, 2), 'utf8')
    const before = readFileSync(join(byEntry.profileDir, 'package.json'), 'utf8')

    const r = await byEntry.vm.deployToProfile(parentId, 'web-test', byEntry.profilesDir)
    assert.equal(r.ok, false, '子副本条目缺失时注入必须失败')
    assert.match(r.error ?? '', /条目缺失/, `错误原因必须明确，实际=${r.error}`)
    assert.equal(readFileSync(join(byEntry.profileDir, 'package.json'), 'utf8'), before, '失败时不得写任何声明')
    assertPathMissing(join(byEntry.profileDir, 'node_modules', 'lonely-parent'), '不得把根单独链进环境')
  } finally {
    rmSync(byEntry.tempDir, { recursive: true, force: true })
  }

  // ---- 变体 C：共同占有时物理源缺失，导致一份子副本都没能建出来 ----
  // （这是「沙箱里明明有这个包、却没变成子副本」的漏洞：若只查组合成员，根会被照常注入而丢掉该依赖）
  const byClosure = makeFixture()
  try {
    const { aId } = await seedSharedDependency(byClosure, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    // 抹掉物理源但保留条目 → 复制的源头没了
    rmSync(join(byClosure.storeDir, 'shared-lib@1.0.0'), { recursive: true, force: true })
    const before = readFileSync(join(byClosure.profileDir, 'package.json'), 'utf8')

    const r = await byClosure.vm.deployToProfile(aId, 'web-test', byClosure.profilesDir)
    assert.equal(r.ok, false, '沙箱里有该包却无法成为子副本时，注入必须失败')
    assert.match(
      r.error ?? '',
      /没能成为|物理源缺失/,
      `错误原因必须明确指向子副本缺失，实际=${r.error}`
    )
    assert.equal(readFileSync(join(byClosure.profileDir, 'package.json'), 'utf8'), before, '失败时不得写任何声明')
    assertPathMissing(join(byClosure.profileDir, 'node_modules', 'parent-alpha'), '不得把根单独链进环境')
    // 附带验证：复制失败时不得把那份公共条目也摘掉（否则该依赖会从沙箱里凭空消失）
    assert.ok(
      byClosure.vm.list().some((p) => p.name === 'shared-lib' && !p.parentId),
      '一份副本都没复制出来时，池里的公共条目必须保留'
    )
  } finally {
    rmSync(byClosure.tempDir, { recursive: true, force: true })
  }
})

test('组合语义4: 根不再声明的陈旧捆绑记录会被清理（避免永久拒绝注入）', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'stale-parent', '1.0.0', { 'stale-dep': '^1.0.0' })
    seedStore(fx, 'stale-dep', '1.0.0')
    await fx.vm.addFromMarket({ name: 'stale-parent', version: '1.0.0' })
    await fx.vm.addFromMarket({ name: 'stale-dep', version: '1.0.0' })
    const rootId = idOf(fx, 'stale-parent')
    await fx.vm.bundleChildrenForParent(rootId, ['stale-dep'])
    const child = fx.vm.list().find((p) => p.parentId === rootId && p.name === 'stale-dep')!
    assert.ok(fx.vm.get(rootId)?.bundledDeps?.includes('stale-dep'), '前置：账上应记录该捆绑子依赖')

    // 造出「根升级后不再声明该依赖」+「那条子副本条目已被清掉」的状态
    const vjPath = join(fx.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vjPath, 'utf8')) as { plugins: { id: string }[] }
    vj.plugins = vj.plugins.filter((p) => p.id !== child.id)
    writeFileSync(vjPath, JSON.stringify(vj, null, 2), 'utf8')
    writeFileSync(
      join(fx.storeDir, 'stale-parent@1.0.0', 'package.json'),
      JSON.stringify({ name: 'stale-parent', version: '1.0.0', dependencies: {} }, null, 2),
      'utf8'
    )

    // 若账上的陈旧名字不被清理，「账实相符」检查会永久拒绝注入，用户没有任何修复入口
    const r = await fx.vm.deployToProfile(rootId, 'web-test', fx.profilesDir)
    assert.equal(r.ok, true, `陈旧记录清理后必须放行注入，实际错误=${r.error}`)
    assert.ok(
      !(fx.vm.get(rootId)?.bundledDeps ?? []).includes('stale-dep'),
      '不再声明且没有子条目的名字必须从账上清掉'
    )
    assertProfileLinkedTo(fx, 'stale-parent', join(fx.storeDir, 'stale-parent@1.0.0'), '根应正常注入')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('组合语义6: 多依赖含孙辈构成同一个组合（删根时整棵子树一起消失）', async () => {
  const fx = makeFixture()
  try {
    // combo-root 依赖 c1、c2；c1 又依赖 grand；other-root 也依赖 c1（于是 c1 是共同占有 → 复制）
    seedStore(fx, 'combo-root', '1.0.0', { 'shared-c1': '^1.0.0', 'shared-c2': '^1.0.0' })
    seedStore(fx, 'other-root', '1.0.0', { 'shared-c1': '^1.0.0' })
    seedStore(fx, 'shared-c1', '1.0.0', { 'shared-grand': '^1.0.0' })
    seedStore(fx, 'shared-c2', '1.0.0')
    seedStore(fx, 'shared-grand', '1.0.0')
    for (const n of ['combo-root', 'other-root', 'shared-c1', 'shared-c2', 'shared-grand']) {
      await fx.vm.addFromMarket({ name: n, version: '1.0.0' })
    }
    const rootId = idOf(fx, 'combo-root')
    const otherId = idOf(fx, 'other-root')

    await fx.vm.bundleChildrenForParent(rootId, ['shared-c1', 'shared-c2'])

    const c1 = fx.vm.list().find((p) => p.parentId === rootId && p.name === 'shared-c1')!
    const c2 = fx.vm.list().find((p) => p.parentId === rootId && p.name === 'shared-c2')!
    const grand = fx.vm.list().find((p) => p.parentId === c1.id && p.name === 'shared-grand')
    assert.ok(c1 && c2, '两个直接子依赖都必须归到根名下')
    assert.ok(grand, '孙辈必须挂在子副本名下（同一个组合的更深一层），而不是成为新的根组合')
    assert.equal(c1.childOrigin, 'shared-copy', 'c1 被两个根共同声明 → 必须是按父隔离的副本')

    const bundle = fx.vm.bundleOf(rootId)
    const bundleIds = bundle.map((m) => m.id).sort()
    assert.deepEqual(
      bundleIds,
      [rootId, c1.id, c2.id, grand.id].sort(),
      `组合 = 根 + 整棵子树，实际=[${bundle.map((m) => m.name).join(',')}]`
    )
    // 从任意成员出发都得到同一个组合（删子即删母的语义基础）
    assert.deepEqual(fx.vm.bundleOf(c1.id).map((m) => m.id).sort(), bundleIds, '从子副本出发也要落到同一个组合')
    assert.deepEqual(fx.vm.bundleOf(grand.id).map((m) => m.id).sort(), bundleIds, '从孙辈出发也要落到同一个组合')
    // other-root 是另一个组合，不得混进来
    assert.ok(!bundleIds.includes(otherId), '另一个组合的根不得被算进本组合')
    assertResolvablePackage(c1.sourcePath!, 'c1 的按父隔离副本必须真实可解析')
    assertResolvablePackage(grand.sourcePath!, '孙辈副本必须真实可解析')

    // 删根：整棵子树（含孙辈）一起消失
    const removed = await fx.vm.remove(rootId, { profilesDir: fx.profilesDir, purge: true })
    assert.equal(removed.ok, true)
    assert.deepEqual(
      [...(removed.removedChildren ?? [])].sort(),
      [c1.id, c2.id, grand.id].sort(),
      'removedChildren 必须覆盖整棵子树（含孙辈）'
    )
    assertPathMissing(c1.sourcePath!, 'c1 的副本目录必须被回收')
    assertPathMissing(c2.sourcePath!, 'c2 的目录必须被回收')
    assertPathMissing(grand.sourcePath!, '孙辈的副本目录必须被回收')
    assert.equal(fx.vm.list().filter((p) => [rootId, c1.id, c2.id, grand.id].includes(p.id)).length, 0, '组合成员条目必须全部消失')
    // other-root 那个组合完好
    assert.ok(fx.vm.list().some((p) => p.id === otherId), '另一个根不得被牵连')
    const otherC1 = fx.vm.list().find((p) => p.parentId === otherId && p.name === 'shared-c1')!
    assertResolvablePackage(otherC1.sourcePath!, '另一个组合的 c1 副本必须完好')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('I2: 按包名复用条目时不得命中并改写别人的子副本', async () => {
  const fx = makeFixture()
  try {
    const { aId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const childBefore = fx.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!
    const childId = childBefore.id
    const childSource = childBefore.sourcePath
    assert.equal(childBefore.version, '1.0.0')

    // 市场暂存同名新版本：旧实现按 name 命中该子副本 → 版本被改成 1.2.0 而 sourcePath 仍指向 1.0.0 的目录
    await fx.vm.addFromMarket({ name: 'shared-lib', version: '1.2.0' })

    const childAfter = fx.vm.list().find((p) => p.id === childId)!
    assert.equal(childAfter.version, '1.0.0', '子副本的版本不得被别人按名复用改写')
    assert.equal(childAfter.sourcePath, childSource, '子副本的 sourcePath 不得被改写')
    assert.equal(childAfter.parentId, aId, '子副本的归属不得被改写')

    const newRoot = fx.vm.list().find((p) => p.name === 'shared-lib' && !p.parentId)
    assert.ok(newRoot, '同名暂存应新建独立根条目，而不是复用子副本')
    assert.equal(newRoot.version, '1.2.0')

    // 按名解析与按 id 解析的边界：按名只能解析根条目，子副本必须用 id
    assert.equal(fx.vm.get('shared-lib')?.id, newRoot.id, 'get(按名) 只应解析根条目')
    assert.equal(fx.vm.get(childId)?.id, childId, 'get(按 id) 仍必须能定位子副本')
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('I5: 子副本不得谎报「自己独立装在哪些环境里」', async () => {
  const fx = makeFixture()
  try {
    const { aId } = await seedSharedDependency(fx, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')

    // 让池里那条公共条目先带上真实的挂载记录（模拟它曾被直接注入过某个环境）
    const vaultJsonPath = join(fx.dataDir, 'vault.json')
    const vj = JSON.parse(readFileSync(vaultJsonPath, 'utf8')) as {
      plugins: { name: string; parentId?: string; installedProfiles?: string[] }[]
    }
    const rootDep = vj.plugins.find((p) => p.name === 'shared-lib' && !p.parentId)!
    rootDep.installedProfiles = ['legacy-profile']
    writeFileSync(vaultJsonPath, JSON.stringify(vj, null, 2), 'utf8')

    await fx.vm.bundleChildrenForParent(aId, ['shared-lib'])

    const copies = fx.vm.list().filter((p) => p.name === 'shared-lib' && p.childOrigin === 'shared-copy')
    assert.equal(copies.length, 2)
    for (const c of copies) {
      assert.deepEqual(
        c.installedProfiles,
        [],
        `子副本是随父捆绑进环境的，不该声称自己独立装在 ${(c.installedProfiles ?? []).join(',')}`
      )
    }
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 删除计数口径：一次请求项 = 一个计数单位（组合级联不计入）                    */
/* ------------------------------------------------------------------ */

test('计数口径: removeMany 按「请求提交的条目数」计数，组合级联不计入，重复/连带提交项判为已移除', async () => {
  // ---- ① 请求 1 个根：删掉的是「根 + 2 个子副本」，但 removed 仍必须是 1 ----
  const one = makeFixture()
  try {
    seedStore(one, 'combo-root', '1.0.0', { 'shared-c1': '^1.0.0', 'shared-c2': '^1.0.0' })
    seedStore(one, 'shared-c1', '1.0.0')
    seedStore(one, 'shared-c2', '1.0.0')
    for (const n of ['combo-root', 'shared-c1', 'shared-c2']) {
      await one.vm.addFromMarket({ name: n, version: '1.0.0' })
    }
    const rootId = idOf(one, 'combo-root')
    await one.vm.bundleChildrenForParent(rootId, ['shared-c1', 'shared-c2'])
    const children = one.vm.list().filter((p) => p.parentId === rootId)
    assert.equal(children.length, 2, '前置：该根名下应有 2 个子副本')

    const r = await one.vm.removeMany([rootId], { profilesDir: one.profilesDir, purge: true })
    assert.equal(r.results.length, 1, '一次请求项 = 一个结果条目')
    assert.equal(r.removed, 1, 'removed 必须等于请求条目数：组合级联是内部实现，不得计入')
    assert.equal(r.blocked, 0)
    assert.equal(r.failed, 0)
    assert.equal(r.results[0]!.bundleRootName, 'combo-root', '结果里要能看出删的是哪个组合')
    assert.equal(r.results[0]!.childrenRemoved, 2, '连带删除的子副本数量单独展示，不混进 removed')
    // 组合确实被整棵删掉了（3 个条目 1 个计数）
    assert.equal(
      one.vm.list().filter((p) => p.id === rootId || children.some((c) => c.id === p.id)).length,
      0,
      '根与两个子副本都必须确实消失'
    )
  } finally {
    rmSync(one.tempDir, { recursive: true, force: true })
  }

  // ---- ② 请求 [子副本 id, 根 id]：两项都指向同一个组合，都应算「已移除」而不是「失败」 ----
  const childFirst = makeFixture()
  try {
    const { aId } = await seedSharedDependency(childFirst, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await childFirst.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const childId = childFirst.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!.id

    const r = await childFirst.vm.removeMany([childId, aId], { profilesDir: childFirst.profilesDir, purge: true })
    assert.equal(r.results.length, 2, '两个请求项 → 两个结果条目')
    assert.equal(r.removed, 2, '两项指向的组合都已被删掉 → 都算 removed')
    assert.equal(r.failed, 0, '重复/连带提交的项不得因为「删过一次」被判为失败')
    assert.equal(r.blocked, 0)
    assert.equal(
      r.results[0]!.bundleRootName,
      'parent-alpha',
      '用子副本 id 删除时也要能看出被删的是哪个组合（API 契约：传子 id 删整个组合）'
    )
  } finally {
    rmSync(childFirst.tempDir, { recursive: true, force: true })
  }

  // ---- ③ 请求 [根 id, 子副本 id]（前端把子行映射成根 id 时的顺序）：同样都要算已移除 ----
  const rootFirst = makeFixture()
  try {
    const { aId } = await seedSharedDependency(rootFirst, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await rootFirst.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const childId = rootFirst.vm.list().find((p) => p.parentId === aId && p.name === 'shared-lib')!.id

    const r = await rootFirst.vm.removeMany([aId, aId, childId], { profilesDir: rootFirst.profilesDir, purge: true })
    assert.equal(r.removed, 3, '三个请求项（含重复的根 id）都必须算作已移除，计数严格等于提交条目数')
    assert.equal(r.failed, 0)
    assert.ok(!rootFirst.vm.list().some((p) => p.id === aId || p.id === childId), '组合必须确实被删掉')
  } finally {
    rmSync(rootFirst.tempDir, { recursive: true, force: true })
  }

  // ---- ④ 两个组合一起提交：removed = 2（而不是 4+ 个条目） ----
  const two = makeFixture()
  try {
    const { aId, bId } = await seedSharedDependency(two, 'shared-lib', '1.0.0', 'parent-alpha', 'parent-beta')
    await two.vm.bundleChildrenForParent(aId, ['shared-lib'])
    const r = await two.vm.removeMany([aId, bId], { profilesDir: two.profilesDir, purge: true })
    assert.equal(r.removed, 2, '两个请求项 = removed 2，不因组合内部条目数而膨胀')
    assert.equal(r.failed, 0)
    assert.equal(two.vm.list().filter((p) => p.name === 'shared-lib' || p.id === aId || p.id === bId).length, 0)
  } finally {
    rmSync(two.tempDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 契约：插件门控 与 启动门禁 必须共用同一个「真 bundle」判据                  */
/*                                                                    */
/* 缺陷：判据曾是「包目录在不在」，而 dsh 要的是「package.json 声明了          */
/* dsh.bundle.patch」。差值（能解析但并非 bundle 的普通插件）被写进           */
/* dsh.profile.bundles 后，dsh 装载时抛错误文本直接硬失败 → 环境打不开。      */
/* 旧门禁同样只验可解析性，所以拦不住；用户唯一出路是跑一次自愈。              */
/* ------------------------------------------------------------------ */

/** 把某个包名强行写进 profile 的 `dsh.profile.bundles`（复现旧门控留下的坏状态）。 */
function forceBundleEntry(fx: Fixture, name: string): void {
  const pkgPath = join(fx.profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
}

/** 真实 dsh CLI 的 node 入口（`lib/bin.js`）；找不到返回 null（调用方 skip 并说明原因）。 */
function resolveDshEntry(): string | null {
  const explicit = process.env.GODSH_DSH_BIN
  if (explicit && existsSync(explicit)) return explicit
  const appData = process.env.APPDATA ?? ''
  if (!appData) return null
  const entry = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(entry) ? entry : null
}

/** dsh 侧 `dsh.bundle.patch` 契约所在源码（`@deepseek-ai/dsh-app-boot` 的编译产物）。 */
function resolveDshAppBootSource(): string | null {
  const entry = resolveDshEntry()
  if (!entry) return null
  const dshRoot = dirname(dirname(entry)) // .../node_modules/@deepseek-ai/dsh
  const candidates = [
    join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
    join(dshRoot, '..', 'dsh-app-boot', 'lib', 'index.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * 跑一次真实的 `dsh --profile <p> --dump-config`。
 *
 * `DSH_HOME` 只指向用例自己的临时目录；此处的硬断言是为了**永久**防止有人把
 * 真实家目录传进来（本项目曾因 `$home` 与只读 `$HOME` 冲突把 DSH_HOME 误设成真实家目录）。
 */
function runDshDumpConfig(dshHome: string, profileName: string): { code: number | null; stdout: string; stderr: string } {
  assert.ok(
    resolve(dshHome).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()),
    `DSH_HOME 必须落在临时目录内，绝不能指向真实环境：${dshHome}`
  )
  const entry = resolveDshEntry()
  assert.ok(entry, '本用例需要真实 dsh CLI 入口（调用前已确认）')
  const r = spawnSync(process.execPath, [entry, '--profile', profileName, '--dump-config'], {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: 90_000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('契约反例: 声明了 dsh.bundle.patch 的包 → 门控接受、启动门禁不报', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'real-bundle', '1.0.0') // 默认就声明 dsh.bundle.patch，与真实 bundle 同形
    await fx.vm.addFromMarket({ name: 'real-bundle', version: '1.0.0' })

    const r = await fx.vm.deployToProfile('vault-market-real-bundle', 'web-test', fx.profilesDir)
    assert.equal(r.ok, true)

    const bundles = readProfilePkg(fx).dsh?.profile?.bundles ?? []
    assert.ok(bundles.includes('real-bundle'), `声明了 dsh.bundle.patch 的包必须被门控接受，实际=${JSON.stringify(bundles)}`)
    assertResolvablePackage(join(fx.profileDir, 'node_modules', 'real-bundle'), '物理必须可解析')

    assert.deepEqual(
      findUnloadableProfileBundles(fx.tempDir, 'web-test'),
      [],
      '启动门禁不得报出合法 bundle'
    )
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('契约: 物理可解析但无 dsh.bundle.patch 的包 → 门控拒绝写入，门禁报出包名与字段名', async () => {
  const fx = makeFixture()
  try {
    // `addFromMarket` 会把条目标成 kind:'bundle'，旧门控据此 + 「能解析」就把它推进了 bundles
    seedStore(fx, 'plain-plugin', '1.0.0', {}, { bundlePatch: null })
    await fx.vm.addFromMarket({ name: 'plain-plugin', version: '1.0.0' })

    const r = await fx.vm.deployToProfile('vault-market-plain-plugin', 'web-test', fx.profilesDir)
    assert.equal(r.ok, true, '注入本身应当成功（它仍是合法依赖，只是不该进 bundles）')

    assertResolvablePackage(
      join(fx.profileDir, 'node_modules', 'plain-plugin'),
      '该包必须物理可解析 —— 用来证明拒绝的原因不是「不可解析」，而是判据升级'
    )

    // ① 门控拒绝写入
    const bundles = readProfilePkg(fx).dsh?.profile?.bundles ?? []
    assert.ok(!bundles.includes('plain-plugin'), `不得把非 bundle 写进 dsh.profile.bundles，实际=${JSON.stringify(bundles)}`)
    assert.equal(isLoadableProfileBundle(fx.profileDir, 'plain-plugin'), false, '判据必须判它不可装载')

    // ② 复现旧门控留下的坏状态：启动门禁必须报出它，且文案要点名包名与缺失字段
    forceBundleEntry(fx, 'plain-plugin')
    const issues = findUnloadableProfileBundles(fx.tempDir, 'web-test')
    assert.equal(issues.length, 1, `应恰好报出 1 个不可装载条目，实际=${JSON.stringify(issues.map((i) => i.name))}`)
    assert.equal(issues[0]!.name, 'plain-plugin')
    assert.equal(issues[0]!.status, 'no-bundle-manifest')

    const reason = describeUnloadableBundles(issues)
    assert.ok(reason.includes('plain-plugin'), `诊断必须点名包名，实际=${reason}`)
    assert.ok(reason.includes('dsh.bundle.patch'), `诊断必须点名缺失字段 dsh.bundle.patch，实际=${reason}`)
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('契约: 已存在的坏 bundles 条目会被门控顺带剔除，官方条目豁免', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'plain-plugin', '1.0.0', {}, { bundlePatch: null })
    await fx.vm.addFromMarket({ name: 'plain-plugin', version: '1.0.0' })
    await fx.vm.deployToProfile('vault-market-plain-plugin', 'web-test', fx.profilesDir)
    forceBundleEntry(fx, 'plain-plugin')
    assert.ok(
      (readProfilePkg(fx).dsh?.profile?.bundles ?? []).includes('plain-plugin'),
      '前置条件：坏条目已存在于 bundles'
    )

    // 再来一次任意注入 → 修剪 pass 必须剔除坏条目，同时保留官方条目
    seedStore(fx, 'real-bundle', '1.0.0')
    await fx.vm.addFromMarket({ name: 'real-bundle', version: '1.0.0' })
    const r = await fx.vm.deployToProfile('vault-market-real-bundle', 'web-test', fx.profilesDir)
    assert.equal(r.ok, true)

    const bundles = readProfilePkg(fx).dsh?.profile?.bundles ?? []
    assert.ok(!bundles.includes('plain-plugin'), `坏条目必须被剔除，实际=${JSON.stringify(bundles)}`)
    assert.ok(bundles.includes('@deepseek-ai/dsh-base'), `官方条目必须豁免（dsh 从安装目录自带解析），实际=${JSON.stringify(bundles)}`)
    assert.ok(bundles.includes('real-bundle'))
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('契约: 门控后的环境 dsh 仍可装载（--dump-config exit 0）；坏条目则硬失败', async (t) => {
  const entry = resolveDshEntry()
  if (!entry) {
    t.skip('未找到真实 dsh CLI 入口，跳过「环境可启动」端到端证明（跳过 ≠ 通过）')
    return
  }
  const fx = makeFixture()
  try {
    // real-bundle 的 patch 真的插入一条条目：这样 dsh 的输出里会出现 `# == real-bundle`
    // 这一段（空 patch 的层不会出现在 dump 里，那样就没有阳性对照可言了）
    seedStore(fx, 'real-bundle', '1.0.0', {}, {
      bundlePatchContent: '- insert:\n    - id: real-bundle-marker\n      name: probe-pkg\n',
    })
    await fx.vm.addFromMarket({ name: 'real-bundle', version: '1.0.0' })
    seedStore(fx, 'plain-plugin', '1.0.0', {}, { bundlePatch: null })
    await fx.vm.addFromMarket({ name: 'plain-plugin', version: '1.0.0' })

    assert.equal((await fx.vm.deployToProfile('vault-market-real-bundle', 'web-test', fx.profilesDir)).ok, true)
    assert.equal((await fx.vm.deployToProfile('vault-market-plain-plugin', 'web-test', fx.profilesDir)).ok, true)

    const bundles = readProfilePkg(fx).dsh?.profile?.bundles ?? []
    assert.ok(!bundles.includes('plain-plugin'), '前置条件：非 bundle 不得被写进 bundles')

    // ① 环境可启动的直接证明
    const okRun = runDshDumpConfig(fx.tempDir, 'web-test')
    assert.equal(okRun.code, 0, `dsh --profile web-test --dump-config 必须 exit 0，实际=${okRun.code}\nstderr=${okRun.stderr}`)
    // 阳性对照：dsh 必须真的把 real-bundle 当 patch 层装载了。
    // 没有这一条，exit 0 可能只是因为「dsh 压根没读这个 profile」，断言就是空转。
    assert.ok(
      okRun.stdout.includes('# == real-bundle'),
      `dsh 输出里必须出现 real-bundle 这一层（否则 exit 0 是空转），stdout 片段=${okRun.stdout.slice(0, 300)}`
    )
    assert.ok(okRun.stdout.includes('real-bundle-marker'), '该层声明的 patch 必须真的生效')

    // ② 负对照：把非 bundle 强行写进 bundles → dsh 立刻硬失败（本缺陷的原始现场）
    forceBundleEntry(fx, 'plain-plugin')
    const badRun = runDshDumpConfig(fx.tempDir, 'web-test')
    assert.notEqual(badRun.code, 0, '把非 bundle 列进 dsh.profile.bundles 必须让 dsh 失败')
    assert.ok(
      `${badRun.stderr}${badRun.stdout}`.includes('declares no dsh.bundle'),
      `dsh 的硬失败文案应与判据对应，实际 stderr 尾部=${badRun.stderr.slice(-500)}`
    )
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('契约: 启动门禁接线在 runPreflightCheck 上生效（不只是判据函数本身）', async () => {
  const fx = makeFixture()
  try {
    seedStore(fx, 'plain-plugin', '1.0.0', {}, { bundlePatch: null })
    await fx.vm.addFromMarket({ name: 'plain-plugin', version: '1.0.0' })
    await fx.vm.deployToProfile('vault-market-plain-plugin', 'web-test', fx.profilesDir)
    forceBundleEntry(fx, 'plain-plugin')

    // 走真正的启动门禁入口（`profiles.ts` 的启动路由消费的就是它）。
    // 只断言判据函数本身不够：那证明不了门禁真的把它接上了 —— 「门禁存在但不站岗」正是本项目的老病。
    const preflight = await runPreflightCheck(fx.tempDir, 'web-test', 3999)
    assert.equal(preflight.ok, false, '坏 bundles 条目必须被启动门禁拦下')
    assert.ok(
      preflight.reason?.includes('plain-plugin'),
      `门禁原因必须点名包名，实际=${preflight.reason}`
    )
    assert.ok(
      preflight.reason?.includes('dsh.bundle.patch'),
      `门禁原因必须点名缺失字段 dsh.bundle.patch，实际=${preflight.reason}`
    )
    assert.equal(preflight.canAutoHeal, true)
  } finally {
    rmSync(fx.tempDir, { recursive: true, force: true })
  }
})

test('契约锚点: dsh 仍要求 profile bundle 声明 dsh.bundle.patch（漂移哨兵）', (t) => {
  const src = resolveDshAppBootSource()
  if (!src) {
    t.skip('未找到 dsh-app-boot 源码（无真实 dsh 安装），锚点未校验（跳过 ≠ 通过）')
    return
  }
  const code = readFileSync(src, 'utf8')
  // 这条**不是**承重用例：它只回答「dsh 的硬失败文案还在不在」。真正证明契约的是上面
  // 那条行为用例（坏条目 → dsh 退出码非 0）。这里保留字符串断言，是为了让 dsh 改动这条
  // 文案时立刻有人来看一眼 —— 代价是文案若被无意义地改写，本用例会误报。
  assert.ok(
    code.includes('declares no dsh.bundle in its package.json'),
    'dsh 的 profile bundle 硬失败文案变了 —— 说明装载契约可能已改，请重新核对 ' +
      `packages/core/src/profile-bundle.ts 的判据。文件=${src}`
  )
})
