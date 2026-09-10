import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MONOREPO_ROOT, DATA_DIR, LOGS_DIR, PLUGINS_DIR, KERNEL_TEMPLATES_DIR, KERNEL_INSTANCES_DIR } from './paths.js'

test('paths: 源码运行时 MONOREPO_ROOT 必须落在真实仓库根上', () => {
  // 判据：该目录下能读到 name 为 godsh 的根 package.json。
  // 打包运行时上溯三级会落到安装目录之外、读不到它，因此 paths.ts 会退回到「产物所在目录」。
  // 这条断言守住的是源码模式不被那次兜底误伤。
  const rootPkg = JSON.parse(readFileSync(join(MONOREPO_ROOT, 'package.json'), 'utf8')) as { name?: string }
  assert.equal(rootPkg.name, 'godsh', `MONOREPO_ROOT 应指向仓库根，实际为 ${MONOREPO_ROOT}`)
})

test('paths: 各派生目录都挂在根目录之下（或由环境变量覆盖）', () => {
  assert.equal(PLUGINS_DIR, join(MONOREPO_ROOT, 'plugins'))
  assert.equal(KERNEL_INSTANCES_DIR, join(MONOREPO_ROOT, 'kernels', 'instances'))
  if (!process.env.DSH_LAUNCHER_TEMPLATES_DIR) {
    assert.equal(KERNEL_TEMPLATES_DIR, join(MONOREPO_ROOT, 'kernels', 'templates'))
  }
  // 日志目录必须跟随数据目录，否则「数据写在 A、日志写在 B」
  assert.equal(LOGS_DIR, join(DATA_DIR, 'logs'))
  if (!process.env.DSH_LAUNCHER_DATA_DIR) {
    assert.equal(DATA_DIR, join(MONOREPO_ROOT, 'data'))
  }
})
