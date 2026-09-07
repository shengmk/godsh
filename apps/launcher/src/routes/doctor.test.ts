import { test } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import { doctorHandler } from './doctor.js'
import { createContext } from '../context.js'

function createMockContext() {
  const base = createContext()
  return {
    ...base,
    sendJson: (res: any, status: number, data: any) => {
      res.writeHead(status)
      res.end(JSON.stringify(data))
    },
  } as any
}

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

test('doctorHandler: POST /api/doctor/diagnose 返回合法的六层体检报告', async () => {
  const ctx = createMockContext()
  const req = {} as http.IncomingMessage
  const res = createMockRes()
  const handled = await doctorHandler(
    ctx,
    req,
    res,
    'POST',
    ['doctor', 'diagnose'],
    { profile: 'web', port: 3080 },
    new URL('http://127.0.0.1:4780/api/doctor/diagnose')
  )

  assert.equal(handled, true)
  assert.equal(res.getStatus(), 200)
  const report = res.getBody()
  assert.ok(report)
  assert.equal(report.profile, 'web')
  assert.ok(['HEALTHY', 'WARNING', 'CRITICAL'].includes(report.overall))
  assert.ok(report.layers.layer0_cli)
  assert.ok(report.layers.layer3_config)
  assert.ok(report.layers.layer5_junctions)
})

test('doctorHandler: POST /api/doctor/preflight 正确返回门禁检查结构', async () => {
  const ctx = createMockContext()
  const req = {} as http.IncomingMessage
  const res = createMockRes()
  const handled = await doctorHandler(
    ctx,
    req,
    res,
    'POST',
    ['doctor', 'preflight'],
    { profile: 'web', port: 3080 },
    new URL('http://127.0.0.1:4780/api/doctor/preflight')
  )

  assert.equal(handled, true)
  assert.equal(res.getStatus(), 200)
  const preflight = res.getBody()
  assert.ok(typeof preflight.ok === 'boolean')
  assert.ok(preflight.report)
})

test('doctorHandler: POST /api/doctor/safe-clean 缺少 profile 抛出 400', async () => {
  const ctx = createMockContext()
  const req = {} as http.IncomingMessage
  const res = createMockRes()
  const handled = await doctorHandler(
    ctx,
    req,
    res,
    'POST',
    ['doctor', 'safe-clean'],
    {},
    new URL('http://127.0.0.1:4780/api/doctor/safe-clean')
  )

  assert.equal(handled, true)
  assert.equal(res.getStatus(), 400)
  assert.ok(res.getBody().error.includes('profile'))
})

test('doctorHandler: 非 doctor 路径返回 false', async () => {
  const ctx = createMockContext()
  const req = {} as http.IncomingMessage
  const res = createMockRes()
  const handled = await doctorHandler(
    ctx,
    req,
    res,
    'GET',
    ['other', 'endpoint'],
    {},
    new URL('http://127.0.0.1:4780/api/other/endpoint')
  )

  assert.equal(handled, false)
})