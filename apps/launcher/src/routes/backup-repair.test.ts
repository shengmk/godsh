import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import { backupHandler } from './backup.js'
import { repairHandler } from './repair.js'
import { tasksHandler } from './tasks.js'

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

test('backupHandler: 完整生命周期（创建、查询、锁定、恢复、日记）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-backup-test-'))
  try {
    const profilesDir = join(tmp, 'profiles')
    const profileName = 'test-bk-profile'
    const pDir = join(profilesDir, profileName)
    mkdirSync(pDir, { recursive: true })

    writeFileSync(join(pDir, 'package.json'), JSON.stringify({ name: profileName, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    writeFileSync(join(pDir, 'cordis.patch.yml'), '[]\n')

    const ctx: any = {
      profilesDir,
      sendJson: (res: any, status: number, data: any) => {
        res.writeHead(status)
        res.end(JSON.stringify(data))
      },
    }

    // 1. POST /api/backup/create
    const res1 = createMockRes()
    const handled1 = await backupHandler(
      ctx,
      {} as any,
      res1,
      'POST',
      ['backup', 'create'],
      { profile: profileName, description: '测试快照' },
      new URL('http://127.0.0.1/api/backup/create')
    )
    assert.equal(handled1, true)
    assert.equal(res1.getStatus(), 201)
    const snap = res1.getBody().snapshot
    assert.ok(snap?.id)

    // 2. GET /api/backup/snapshots?profile=...
    const res2 = createMockRes()
    const handled2 = await backupHandler(
      ctx,
      {} as any,
      res2,
      'GET',
      ['backup', 'snapshots'],
      {},
      new URL(`http://127.0.0.1/api/backup/snapshots?profile=${profileName}`)
    )
    assert.equal(handled2, true)
    assert.equal(res2.getStatus(), 200)
    assert.equal(res2.getBody().snapshots.length, 1)

    // 3. POST /api/backup/toggle-lock
    const res3 = createMockRes()
    await backupHandler(
      ctx,
      {} as any,
      res3,
      'POST',
      ['backup', 'toggle-lock'],
      { profile: profileName, snapshotId: snap.id, isLocked: true },
      new URL('http://127.0.0.1/api/backup/toggle-lock')
    )
    assert.equal(res3.getStatus(), 200)
    assert.equal(res3.getBody().isLocked, true)

    // 4. POST /api/backup/restore
    const res4 = createMockRes()
    await backupHandler(
      ctx,
      {} as any,
      res4,
      'POST',
      ['backup', 'restore'],
      { profile: profileName, snapshotId: snap.id },
      new URL('http://127.0.0.1/api/backup/restore')
    )
    assert.equal(res4.getStatus(), 200)
    assert.equal(res4.getBody().ok, true)

    // 5. GET /api/journal
    const res5 = createMockRes()
    await backupHandler(
      ctx,
      {} as any,
      res5,
      'GET',
      ['journal'],
      {},
      new URL(`http://127.0.0.1/api/journal?profile=${profileName}`)
    )
    assert.equal(res5.getStatus(), 200)
    assert.ok(res5.getBody().entries.length >= 2)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('repairHandler & tasksHandler: 异步自愈任务与全局任务中心', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'godsh-repair-route-test-'))
  try {
    const profilesDir = join(tmp, 'profiles')
    const profileName = 'repair-p'
    const pDir = join(profilesDir, profileName)
    mkdirSync(pDir, { recursive: true })
    writeFileSync(join(pDir, 'package.json'), JSON.stringify({ name: profileName }))

    const tasks = new Map<string, any>()
    const ctx: any = {
      profilesDir,
      env: { dshHome: join(tmp, 'dsh-home') },
      installTasks: tasks,
      sendJson: (res: any, status: number, data: any) => {
        res.writeHead(status)
        res.end(JSON.stringify(data))
      },
      startInstallTask: (key: string, _log: string, job: any) => {
        const item = { status: 'running', log: '开始自愈\n' }
        tasks.set(key, item)
        setTimeout(async () => {
          try {
            await job((line: string) => { item.log += line })
            item.status = 'done'
          } catch (err) {
            item.status = 'error'
          }
        }, 10)
      },
      installTaskView: (key: string) => tasks.get(key) ?? null,
    }

    // 1. POST /api/repair/workflow
    const res1 = createMockRes()
    const handled1 = await repairHandler(
      ctx,
      {} as any,
      res1,
      'POST',
      ['repair', 'workflow'],
      { profile: profileName },
      new URL('http://127.0.0.1/api/repair/workflow')
    )
    assert.equal(handled1, true)
    assert.equal(res1.getStatus(), 202)
    const taskKey = res1.getBody().task
    assert.ok(taskKey)

    // 2. GET /api/tasks
    const res2 = createMockRes()
    const handled2 = await tasksHandler(
      ctx,
      {} as any,
      res2,
      'GET',
      ['tasks'],
      {},
      new URL('http://127.0.0.1/api/tasks')
    )
    assert.equal(handled2, true)
    assert.equal(res2.getStatus(), 200)
    assert.equal(res2.getBody().tasks.length, 1)
    assert.equal(res2.getBody().tasks[0].type, 'repair')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
