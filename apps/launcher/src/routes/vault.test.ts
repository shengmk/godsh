import { test } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import { vaultHandler } from './vault.js'
import { createContext } from '../context.js'

function createMockRes() {
  let statusCode = 0
  let body: any = null
  const res = {
    writeHead(status: number) {
      statusCode = status
    },
    end(data?: any) {
      if (data) {
        try {
          body = JSON.parse(data)
        } catch {
          body = data
        }
      }
    },
    getStatus() {
      return statusCode
    },
    getBody() {
      return body
    },
  } as unknown as http.ServerResponse & { getStatus(): number; getBody(): any }
  return res
}

test('vaultHandler: 异步后台任务与进度轮询端点端到端验证', async () => {
  const base = createContext()
  const tasks = new Map<string, { status: string; log: string; message?: string }>()

  const ctx: any = {
    ...base,
    sendJson: (res: any, status: number, data: any) => {
      res.writeHead(status)
      res.end(JSON.stringify(data))
    },
    startInstallTask: (key: string, _logName: string, job: (log: (line: string) => void) => Promise<void>) => {
      tasks.set(key, { status: 'running', log: '开始...\n' })
      // 模拟后台异步执行
      setTimeout(async () => {
        const item = tasks.get(key)
        if (item) {
          try {
            await job((line) => {
              item.log += line
            })
            item.status = 'done'
          } catch (e) {
            item.status = 'error'
            item.message = String(e)
          }
        }
      }, 10)
    },
    installTaskView: (key: string) => {
      return tasks.get(key) ?? null
    },
    vault: {
      ...base.vault,
      updateAll: async (_profilesDir?: string, onLog?: (msg: string) => void) => {
        onLog?.('开始比对最新版本...\n')
        onLog?.('[1/1] 升级插件: test-plugin (1.0.0 -> 1.0.1)\n')
        onLog?.('[1/4] 下载依赖包: test-plugin@1.0.1 ...\n')
        return { total: 1, updated: 1, failed: 0, results: [] }
      },
      updatePlugin: async (id: string, ver?: string, _profilesDir?: string, onLog?: (msg: string) => void) => {
        onLog?.(`[1/4] 下载依赖包: ${id}@${ver || '1.0.0'} ...\n`)
        return { ok: true, plugin: { id, name: id, version: ver || '1.0.0' }, toVersion: ver || '1.0.0' }
      },
    },
  }

  const req = {} as http.IncomingMessage

  // 1. 验证 POST /api/vault/update-all { async: true } 派发异步任务
  const res1 = createMockRes()
  const handled1 = await vaultHandler(
    ctx,
    req,
    res1,
    'POST',
    ['vault', 'update-all'],
    { async: true },
    new URL('http://127.0.0.1:4780/api/vault/update-all')
  )
  assert.equal(handled1, true)
  assert.equal(res1.getStatus(), 202)
  const body1 = res1.getBody()
  assert.equal(body1.ok, true)
  assert.ok(body1.task)
  assert.match(body1.task, /^vault-update-all-/)

  // 2. 验证 GET /api/vault/task-progress?task=... 轮询有效任务
  const res2 = createMockRes()
  const handled2 = await vaultHandler(
    ctx,
    req,
    res2,
    'GET',
    ['vault', 'task-progress'],
    {},
    new URL(`http://127.0.0.1:4780/api/vault/task-progress?task=${body1.task}`)
  )
  assert.equal(handled2, true)
  assert.equal(res2.getStatus(), 200)
  const body2 = res2.getBody()
  assert.ok(body2.status === 'running' || body2.status === 'done')
  assert.ok(body2.log.includes('开始'))

  // 3. 验证 GET /api/vault/task-progress 不存在的任务返回 404
  const res3 = createMockRes()
  const handled3 = await vaultHandler(
    ctx,
    req,
    res3,
    'GET',
    ['vault', 'task-progress'],
    {},
    new URL('http://127.0.0.1:4780/api/vault/task-progress?task=non-existent-task')
  )
  assert.equal(handled3, true)
  assert.equal(res3.getStatus(), 404)

  // 4. 验证 POST /api/vault/update { id: 'test-plugin', async: true }
  const res4 = createMockRes()
  const handled4 = await vaultHandler(
    ctx,
    req,
    res4,
    'POST',
    ['vault', 'update'],
    { id: 'test-plugin', version: '2.0.0', async: true },
    new URL('http://127.0.0.1:4780/api/vault/update')
  )
  assert.equal(handled4, true)
  assert.equal(res4.getStatus(), 202)
  const body4 = res4.getBody()
  assert.equal(body4.ok, true)
  assert.ok(body4.task)
  assert.match(body4.task, /^vault-update-test-plugin-/)
})
