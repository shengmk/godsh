import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultManager } from './vault.js'
import { getVaultContract, detectPluginConflicts } from './vault-contract.js'

test('VaultContract: 正确读取已知插件伴随与垫片契约', () => {
  const contract = getVaultContract('dsh-web-search-pro')
  assert.ok(contract)
  assert.equal(contract.companions?.length, 1)
  assert.equal(contract.companions[0]?.pkg, '@anweat/dsh-browser')
  assert.ok(contract.requiredShims?.includes('settings-namespace'))

  const conflicts = detectPluginConflicts('dsh-dream-skin', ['@kubor/dsh-bloom-theme', 'dsh-other'])
  assert.deepEqual(conflicts, ['@kubor/dsh-bloom-theme'])
})

test('VaultManager: 零拷贝 NTFS Junction 挂载与伴随插件自愈注入', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'godsh-vault-test-'))
  try {
    const dataDir = join(tempDir, 'data')
    const profilesDir = join(tempDir, 'profiles')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(profilesDir, { recursive: true })

    // 创建测试 Profile
    const profileDir = join(profilesDir, 'web-test')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web-test',
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }),
      'utf8'
    )

    // 创建源插件物理目录
    const storeDir = join(dataDir, 'vault_store')
    const pkgDir = join(storeDir, 'dsh-web-search-pro@0.1.11')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-web-search-pro', version: '0.1.11' }), 'utf8')

    // 创建伴随插件物理目录
    const compDir = join(storeDir, '@anweat_dsh-browser@0.1.10')
    mkdirSync(compDir, { recursive: true })
    writeFileSync(join(compDir, 'package.json'), JSON.stringify({ name: '@anweat/dsh-browser', version: '0.1.10' }), 'utf8')

    const vm = new VaultManager(dataDir)
    await vm.addFromMarket({ name: 'dsh-web-search-pro', version: '0.1.11', description: '网页搜索插件' })
    await vm.addFromMarket({ name: '@anweat/dsh-browser', version: '0.1.10', description: '浏览器服务插件' })

    // 执行挂载
    const deployRes = await vm.deployToProfile('vault-market-dsh-web-search-pro', 'web-test', profilesDir)
    assert.equal(deployRes.ok, true)
    assert.ok(deployRes.deployed.includes('dsh-web-search-pro'))
    assert.ok(deployRes.companionAdded.includes('@anweat/dsh-browser'))

    // 验证目标环境 package.json
    const pkgAfter = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.ok(pkgAfter.dependencies['dsh-web-search-pro'])
    assert.ok(pkgAfter.dependencies['@anweat/dsh-browser'])
    assert.ok(pkgAfter.dsh.profile.bundles.includes('dsh-web-search-pro'))
    assert.ok(pkgAfter.dsh.profile.bundles.includes('@anweat/dsh-browser'))

    // 验证 node_modules 中 junction 或软链已建立
    const targetNm = join(profileDir, 'node_modules', 'dsh-web-search-pro')
    assert.ok(existsSync(targetNm))
    const st = lstatSync(targetNm)
    assert.ok(st.isSymbolicLink() || existsSync(join(targetNm, 'package.json')))

    // 验证指标计算
    const metrics = vm.calculateDiskSavings(profilesDir)
    assert.ok(metrics.pluginCount >= 2)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('VaultManager: 多版本切换与一键快照回滚', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'godsh-vault-ver-'))
  try {
    const dataDir = join(tempDir, 'data')
    const profilesDir = join(tempDir, 'profiles')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(profilesDir, { recursive: true })

    const profileDir = join(profilesDir, 'my-profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'my-profile', dependencies: {} }),
      'utf8'
    )

    const storeDir = join(dataDir, 'vault_store')
    const v1Dir = join(storeDir, 'test-plugin@1.0.0')
    const v2Dir = join(storeDir, 'test-plugin@2.0.0')
    mkdirSync(v1Dir, { recursive: true })
    mkdirSync(v2Dir, { recursive: true })
    writeFileSync(join(v1Dir, 'package.json'), JSON.stringify({ name: 'test-plugin', version: '1.0.0' }), 'utf8')
    writeFileSync(join(v2Dir, 'package.json'), JSON.stringify({ name: 'test-plugin', version: '2.0.0' }), 'utf8')

    const vm = new VaultManager(dataDir)
    await vm.addFromMarket({ name: 'test-plugin', version: '1.0.0' })

    // 1. 初次部署 1.0.0
    await vm.deployToProfile('vault-market-test-plugin', 'my-profile', profilesDir, '1.0.0')
    let pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['test-plugin'], '^1.0.0')

    // 2. 切换升级到 2.0.0
    await vm.switchVersion('vault-market-test-plugin', 'my-profile', '2.0.0', profilesDir)
    pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['test-plugin'], '^2.0.0')

    // 3. 一键快照回滚至 1.0.0
    const rollRes = await vm.rollback('my-profile', 'vault-market-test-plugin', profilesDir)
    assert.equal(rollRes.ok, true)
    assert.ok(rollRes.rolledBackTo.includes('1.0.0'))
    pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['test-plugin'], '^1.0.0')


    // 4. 热拔插安全卸载
    const unmountRes = await vm.unmountFromProfile('vault-market-test-plugin', 'my-profile', profilesDir)
    assert.equal(unmountRes.ok, true)
    pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['test-plugin'], undefined)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('VaultManager: harvestSingle 能够将环境中已安装的插件存入/下至沙箱', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'godsh-harvest-test-'))
  try {
    const dataDir = join(tempDir, 'data')
    const profilesDir = join(tempDir, 'profiles')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(profilesDir, { recursive: true })

    const profileDir = join(profilesDir, 'my-prod-profile')
    const nmDir = join(profileDir, 'node_modules', 'custom-plugin')
    mkdirSync(nmDir, { recursive: true })
    writeFileSync(
      join(nmDir, 'package.json'),
      JSON.stringify({ name: 'custom-plugin', version: '1.2.3', description: '环境已安装插件' }),
      'utf8'
    )
    writeFileSync(join(nmDir, 'index.js'), 'module.exports = { test: true }', 'utf8')

    const vm = new VaultManager(dataDir)
    const result = await vm.harvestSingle('my-prod-profile', 'custom-plugin', profilesDir)
    assert.equal(result.ok, true)
    assert.ok(result.plugin)
    assert.equal(result.plugin?.name, 'custom-plugin')
    assert.equal(result.plugin?.version, '1.2.3')
    assert.ok(result.plugin?.installedProfiles?.includes('my-prod-profile'))

    // 验证沙箱 store 中物理落地
    const storeTarget = join(dataDir, 'vault_store', 'custom-plugin@1.2.3')
    assert.ok(existsSync(storeTarget))
    assert.ok(existsSync(join(storeTarget, 'package.json')))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

