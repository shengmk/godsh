import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProcessesByProfile, killAllProfileProcesses, extractDshWebUrl, hasAuthToken, buildProfileProcessQuery } from './process-manager.js'
import { ConfigStore } from './config-store.js'
import { run } from './run.js'

test('findProcessesByProfile: 不存在的 profile 返回空数组', async () => {
  const pids = await findProcessesByProfile('non_existent_profile_xyz_' + Date.now())
  assert.ok(Array.isArray(pids))
  assert.equal(pids.length, 0)
})

test('findProcessesByProfile: 非法特殊字符环境名安全转义', async () => {
  const pids = await findProcessesByProfile(';rm -rf /; && calc.exe')
  assert.ok(Array.isArray(pids))
  assert.equal(pids.length, 0)
})

test('buildProfileProcessQuery: 只索取 ProcessId 与 CommandLine（?06 性能回归守卫）', () => {
  const q = buildProfileProcessQuery('web')
  assert.ok(q, '合法环境名必须生成查询串')
  // 属性裁剪是 3796ms → 487ms 的全部原因，一旦被删掉就是性能回归
  assert.ok(q!.includes('-Property ProcessId,CommandLine'), '查询必须裁剪属性')
  assert.ok(q!.includes("Name = 'node.exe' or Name = 'cmd.exe'"), '仍应在 WMI 阶段限制进程名')
  assert.ok(q!.includes('--profile'), '仍按 --profile 匹配命令行')
  // 不得退回同步实现所依赖的全属性检索
  assert.equal(q!.includes('-Property *'), false)
})

test('buildProfileProcessQuery: 非法特殊字符环境名被净化，且空名不产生查询', () => {
  const raw = ';rm -rf /; && calc.exe'
  // 净化规则：只保留 [a-zA-Z0-9_-]，因此该串应变成 rm-rfcalcexe（点号也被去掉）
  const q = buildProfileProcessQuery(raw)
  assert.ok(q, '净化后仍有字母数字，应生成查询串')
  assert.ok(q!.includes('rm-rfcalcexe'), `净化结果应为 rm-rfcalcexe，实际查询串为 ${q}`)
  // 注入用的分隔符/命令拼接符必须全部消失
  for (const bad of ['rm -rf', '&&', ';', '/;', ' / ']) {
    assert.equal(q!.includes(bad), false, `净化后不应残留 ${bad}`)
  }

  // 全是非法字符时不得生成查询（避免空 profile 匹配到任意进程）
  assert.equal(buildProfileProcessQuery(';;; &&& ///'), null)
  assert.equal(buildProfileProcessQuery(''), null)
})

test('buildProfileProcessQuery: 查询串能在 PowerShell 里解析（单引号必须成对）', () => {
  const q = buildProfileProcessQuery('web')!
  // PowerShell 单引号字符串内的字面单引号必须写成两个，否则整条命令语法错误。
  // 这里固定住「成对单引号」这一形式，防止再次退回 `["']` 那种写法。
  assert.ok(q.includes(`["'']?web["'']?`), `查询串里的引号必须成对，实际为 ${q}`)
  assert.equal(q.includes(`["']?web`), false, '不得出现未成对的单引号形式')
})

test(
  'findProcessesByProfile: 能真正找到带 --profile 的活进程（查询串可执行性回归）',
  { skip: process.platform !== 'win32' },
  async () => {
    // 起一个只带标记参数、不做任何事的长命进程，让命令行里出现 --profile <marker>
    const marker = `godshscan${Date.now().toString(36)}`
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', '--profile', marker], {
      stdio: 'ignore',
      windowsHide: true,
    })
    try {
      await new Promise((r) => setTimeout(r, 1000))
      // 该查询要 spawn 一次 PowerShell，本机冷启动 3.2–7.3 秒；机器忙时仍可能抖动，
      // 因此重试一次。注意：**不能**把断言放宽成「允许空结果」——那正是这条测试要防的回归。
      let pids: number[] = []
      for (let attempt = 1; attempt <= 2; attempt++) {
        pids = await findProcessesByProfile(marker)
        if (child.pid && pids.includes(child.pid)) break
        await new Promise((r) => setTimeout(r, 500))
      }
      assert.ok(
        child.pid && pids.includes(child.pid),
        `应找到自己起的 pid ${child.pid}，实际返回 [${pids.join(', ')}]（若为空说明查询串又变回「语法错误 + 静默吞掉」，或查询超时）`
      )
    } finally {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
    }
  }
)

test('killAllProfileProcesses: 端口快路径不 spawn PowerShell（?06 回归守卫）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pid-fast-'))
  try {
    // 登记一个不存在的 PID：快路径只应读 pid 文件 + netstat，绝不启 PowerShell
    writeFileSync(join(dir, 'service-pid-45999.txt'), '9999998', 'utf8')
    const t0 = Date.now()
    const res = await killAllProfileProcesses(dir, 'web', { ports: [45999] })
    const ms = Date.now() - t0

    assert.equal(res.killed, 0)
    assert.equal(existsSync(join(dir, 'service-pid-45999.txt')), false, '死进程的登记文件应被清理')
    // 本机实测 powershell.exe 空跑需 3.2–7.3 秒；快路径必须远离这个量级
    assert.ok(ms < 3000, `端口快路径耗时 ${ms}ms，疑似回退到 PowerShell 深扫`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('killAllProfileProcesses: 空 pid 目录安全执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pid-test-'))
  try {
    const res = await killAllProfileProcesses(dir, 'test-profile-none')
    assert.equal(res.killed, 0)
    assert.deepEqual(res.pids, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('killAllProfileProcesses: 自动清理 dead 状态的 service-pid 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-pid-test-'))
  try {
    writeFileSync(join(dir, 'service-pid-49999.txt'), '9999999', 'utf8')
    assert.ok(existsSync(join(dir, 'service-pid-49999.txt')))

    await killAllProfileProcesses(dir, 'any-profile')
    assert.equal(existsSync(join(dir, 'service-pid-49999.txt')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ConfigStore: allowMultiPort 默认值为 false，可持久化保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-cfg-test-'))
  try {
    const store = new ConfigStore(dir)
    const cfg1 = store.readConfig()
    assert.equal(cfg1.webKernel.allowMultiPort, false)

    store.writeConfig({
      ...cfg1,
      webKernel: { ...cfg1.webKernel, allowMultiPort: true },
    })

    const cfg2 = store.readConfig()
    assert.equal(cfg2.webKernel.allowMultiPort, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run: 执行命令时触发 onLog 流式输出回调', async () => {
  const chunks: string[] = []
  const res = await run(process.execPath, ['-e', 'console.log("stream-test-1"); console.log("stream-test-2")'], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    onLog: (chunk) => chunks.push(chunk),
  })

  assert.equal(res.ok, true)
  assert.equal(res.code, 0)
  assert.ok(res.stdout.includes('stream-test-1'))
  assert.ok(res.stdout.includes('stream-test-2'))
  assert.ok(chunks.length > 0)
  assert.ok(chunks.join('').includes('stream-test-1'))
})

test('extractDshWebUrl: 从日志中提取含 token 的认证 URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-url-test-'))
  try {
    const logFile = join(dir, 'test.log')
    assert.equal(extractDshWebUrl(logFile), null)

    writeFileSync(
      logFile,
      `[lingshu-bridge] init\ndsh web: http://127.0.0.1:3200/?token=abc123xyz (LAN: http://192.168.1.5:3200/?token=abc123xyz)\nready\n`,
      'utf8'
    )
    assert.equal(extractDshWebUrl(logFile), 'http://127.0.0.1:3200/?token=abc123xyz')

    writeFileSync(
      logFile,
      `[lingshu-bridge] init\ndsh web: http://127.0.0.1:3080\nready\n`,
      'utf8'
    )
    assert.equal(extractDshWebUrl(logFile), 'http://127.0.0.1:3080')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasAuthToken: 只有含 token 的地址才视为可用（bug 6 的核心守卫）', () => {
  // 无 token 的地址在当前 dsh 上必然 401，绝不能被当作可点链接
  assert.equal(hasAuthToken('http://127.0.0.1:3080'), false)
  assert.equal(hasAuthToken('http://127.0.0.1:3080/'), false)
  // 带 token（根路径形式与多参数形式）
  assert.equal(hasAuthToken('http://127.0.0.1:3296/?token=X'), true)
  assert.equal(hasAuthToken('http://127.0.0.1:3296/?a=1&token=X'), true)
  // 空值/未就绪
  assert.equal(hasAuthToken(''), false)
  assert.equal(hasAuthToken(null), false)
  assert.equal(hasAuthToken(undefined), false)
  // 近似但非 token 的参数名不应误判
  assert.equal(hasAuthToken('http://127.0.0.1:3296/?tokenizer=X'), false)
})

