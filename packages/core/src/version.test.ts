import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from './version.js'

// packages/core/src/version.test.ts → 上溯三级 = 仓库根
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('APP_VERSION 与仓库根 package.json 的 version 一致（唯一真源）', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string }
  assert.equal(APP_VERSION, pkg.version)
})

test('APP_VERSION 是语义化版本，且不是开发兜底值', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/)
  assert.notEqual(APP_VERSION, '0.0.0-dev', 'APP_VERSION 落到兜底值说明无法定位根 package.json')
})
