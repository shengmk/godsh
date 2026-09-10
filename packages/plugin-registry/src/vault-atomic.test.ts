import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultManager } from './vault.js'

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

/** 在沙箱池里造一个物理插件包。 */
function seedStore(fx: Fixture, name: string, version: string, extraDeps: Record<string, string> = {}): string {
  const sanitized = name.replace(/[^a-zA-Z0-9@._-]/g, '_')
  const dir = join(fx.storeDir, `${sanitized}@${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, dependencies: extraDeps }, null, 2),
    'utf8'
  )
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
