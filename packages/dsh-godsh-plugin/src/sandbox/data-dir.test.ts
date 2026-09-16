import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSandboxDataDir } from './data-dir.js'

/**
 * 沙箱数据目录解析的**离线**单测。
 *
 * 为什么这条判据值得单独钉住：`@godsh/dsh` 跑在 dsh 进程内，而沙箱一直是 godsh 启动器在管。
 * 如果这里算错一个目录，用户在 dsh 里的沙箱页看到的就是**另一份空沙箱** ——
 * 那不是"在 dsh 里管沙箱"，那是"又造了一个沙箱"，而且几乎不可能被肉眼发现。
 *
 * 判据必须与启动器逐字一致（`apps/launcher/src-tauri/src/lib.rs:48-54` 的 `data_dir()`）：
 * `DSH_LAUNCHER_DATA_DIR` 优先，否则 `%APPDATA%\godsh\data`。
 */

test('优先使用 DSH_LAUNCHER_DATA_DIR（启动器打包运行时就是这条）', () => {
  const r = resolveSandboxDataDir({ DSH_LAUNCHER_DATA_DIR: 'D:\\some\\data', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\cwd')
  assert.equal(r.from, 'env')
  assert.match(r.dir, /some[\\/]data$/)
})

test('空白字符串不算指定（回落 APPDATA，而不是拼出一个空路径）', () => {
  const r = resolveSandboxDataDir({ DSH_LAUNCHER_DATA_DIR: '   ', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\cwd')
  assert.equal(r.from, 'appdata')
  assert.match(r.dir, /godsh[\\/]data$/)
})

test('无环境变量时用 %APPDATA%\\godsh\\data（与启动器默认值逐字一致）', () => {
  const r = resolveSandboxDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\cwd')
  assert.equal(r.from, 'appdata')
  assert.ok(r.dir.endsWith(`godsh\\data`) || r.dir.endsWith('godsh/data'), r.dir)
  assert.ok(r.dir.startsWith('C:\\Users\\x\\AppData\\Roaming'), r.dir)
})

test('无 APPDATA 时落到 $DSH_HOME/godsh/data（非 Windows 兜底，不污染系统目录）', () => {
  const r = resolveSandboxDataDir({ DSH_HOME: 'C:\\home\\.dsh' }, 'C:\\cwd')
  assert.equal(r.from, 'dsh-home')
  assert.match(r.dir, /\.dsh[\\/]godsh[\\/]data$/)
})

test('明示 DSH_HOME 优先于 USERPROFILE 推导', () => {
  const explicit = resolveSandboxDataDir({ DSH_HOME: 'D:\\explicit\\.dsh', USERPROFILE: 'C:\\Users\\x' }, 'C:\\cwd')
  const derived = resolveSandboxDataDir({ USERPROFILE: 'C:\\Users\\x' }, 'C:\\cwd')
  assert.equal(explicit.from, 'dsh-home')
  assert.ok(explicit.dir.startsWith('D:\\explicit'), explicit.dir)
  assert.ok(derived.dir.includes('Users'), derived.dir)
})

test('变量全缺时退回 cwd（并如实标注来源，便于自检面板解释"为什么是这个目录"）', () => {
  const r = resolveSandboxDataDir({}, 'C:\\cwd')
  assert.equal(r.from, 'cwd-fallback')
  assert.ok(r.dir.startsWith('C:\\cwd'), r.dir)
  assert.match(r.reason, /环境变量全部缺失/)
})

test('返回的 dir 是绝对路径，且四种来源都有可读的 reason', () => {
  const cases = [
    { env: { DSH_LAUNCHER_DATA_DIR: 'D:\\a' }, from: 'env' },
    { env: { APPDATA: 'C:\\b' }, from: 'appdata' },
    { env: { DSH_HOME: 'C:\\c' }, from: 'dsh-home' },
    { env: {}, from: 'cwd-fallback' },
  ] as const
  for (const c of cases) {
    const r = resolveSandboxDataDir(c.env, 'C:\\cwd')
    assert.equal(r.from, c.from)
    assert.ok(r.reason.length > 0, `来源 ${c.from} 应有可读说明`)
    // 绝对路径判据：Windows 盘符或 POSIX 根
    assert.ok(/^[A-Za-z]:[\\/]/.test(r.dir) || r.dir.startsWith('/'), r.dir)
  }
})
