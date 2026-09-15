import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWN_OFFICIAL_BUNDLES,
  OFFICIAL_PACKAGE_SCOPE,
  isOfficialPackage,
  officialRole,
  officialShortName,
} from './dsh-official.js'

test('isOfficialPackage: 只认作用域前缀，且要求短名非空', () => {
  // 三个已知内核 bundle
  assert.equal(isOfficialPackage('@deepseek-ai/dsh-base'), true)
  assert.equal(isOfficialPackage('@deepseek-ai/dsh-web-app'), true)
  assert.equal(isOfficialPackage('@deepseek-ai/dsh-headless'), true)
  // 官方将来新增的包自动落为 true —— 这正是「用前缀而不是枚举」的意义
  assert.equal(isOfficialPackage('@deepseek-ai/dsh-brand-new-thing'), true)
  // 只有前缀、短名为空 → 畸形输入，必须为 false（否则会把空包名判成官方）
  assert.equal(isOfficialPackage('@deepseek-ai/'), false)
  assert.equal(isOfficialPackage('@deepseek-ai'), false)
  // 社区包与相似前缀都不能误判
  assert.equal(isOfficialPackage('dsh-skill-hub'), false)
  assert.equal(isOfficialPackage('@linxin666/dsh-client-ui-git-graph'), false)
  assert.equal(isOfficialPackage('@kubor/dsh-bloom-theme'), false)
  assert.equal(isOfficialPackage('@deepseek-ai-extra/dsh-base'), false)
  assert.equal(isOfficialPackage('dsh-base'), false)
  assert.equal(isOfficialPackage(''), false)
})

test('officialRole: 三个内核 bundle 有角色，其它官方包为 other，非官方为 null', () => {
  assert.equal(officialRole('@deepseek-ai/dsh-base'), 'base')
  assert.equal(officialRole('@deepseek-ai/dsh-web-app'), 'web-app')
  assert.equal(officialRole('@deepseek-ai/dsh-headless'), 'headless')
  assert.equal(officialRole('@deepseek-ai/dsh-client-modules'), 'other')
  assert.equal(officialRole('dsh-skill-hub'), null)
  assert.equal(officialRole('@deepseek-ai/'), null)
})

test('officialShortName: 只剥离作用域，不做其它改写', () => {
  assert.equal(officialShortName('@deepseek-ai/dsh-base'), 'dsh-base')
  assert.equal(officialShortName('@deepseek-ai/dsh-web-app'), 'dsh-web-app')
  assert.equal(officialShortName('dsh-base'), '')
  assert.equal(officialShortName(OFFICIAL_PACKAGE_SCOPE), '')
})

test('KNOWN_OFFICIAL_BUNDLES: 展示清单自洽且与角色判定一致', () => {
  assert.equal(KNOWN_OFFICIAL_BUNDLES.length, 3)
  for (const asset of KNOWN_OFFICIAL_BUNDLES) {
    assert.equal(isOfficialPackage(asset.name), true)
    // 展示清单里的每一条都必须与 officialRole 的判定一致（否则界面与判定会漂移）
    assert.equal(officialRole(asset.name), asset.role)
    assert.notEqual(asset.role, 'other')
  }
  const roles = KNOWN_OFFICIAL_BUNDLES.map((a) => a.role).sort()
  assert.deepEqual(roles, ['base', 'headless', 'web-app'])
})
