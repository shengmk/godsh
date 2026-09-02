import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatchManager } from './patch-manager.js'
import { BackupManager } from './backup-manager.js'
import { MemoryEngine } from './memory-engine.js'
import { GodshService } from './service.js'
import { apply } from './index.js'
import type { CordisContext } from './types.js'

function createMockContext(): CordisContext & { events: Map<string, Function[]> } {
  const events = new Map<string, Function[]>()
  return {
    events,
    emit(event: string, ...args: unknown[]) {
      const handlers = events.get(event) ?? []
      for (const h of handlers) h(...args)
      return handlers.length > 0
    },
    on(event: string, listener: (...args: any[]) => void) {
      const handlers = events.get(event) ?? []
      handlers.push(listener)
      events.set(event, handlers)
      return () => {
        const idx = handlers.indexOf(listener)
        if (idx !== -1) handlers.splice(idx, 1)
      }
    },
    plugin() {},
    provide() {},
  }
}

test('PatchManager: 热启用与热禁用插件到 cordis.patch.yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-patch-test-'))
  try {
    const profileDir = join(dir, 'test-profile')
    mkdirSync(profileDir, { recursive: true })
    const pm = new PatchManager(dir)

    pm.enablePlugin('test-profile', 'plugin-a')
    let list = pm.readPatch('test-profile')
    assert.deepEqual(list, ['plugin-a'])

    pm.disablePlugin('test-profile', 'plugin-a')
    list = pm.readPatch('test-profile')
    assert.deepEqual(list, ['plugin-a'])

    pm.enablePlugin('test-profile', 'plugin-b')
    list = pm.readPatch('test-profile')
    assert.ok(list.includes('plugin-b'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BackupManager: 创建快照、列出快照与一键回滚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-backup-test-'))
  try {
    const profileDir = join(dir, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dependencies: { 'pkg-v1': '^1.0.0' } }), 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '$patch:\n  - insert: [pkg-v1]\n', 'utf8')

    const bm = new BackupManager(join(dir, 'profiles'), join(dir, 'backups'))
    const snap = bm.createSnapshot('web', 'before-upgrade')
    assert.equal(snap.profile, 'web')
    assert.equal(snap.tag, 'before-upgrade')

    const list = bm.listSnapshots('web')
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, snap.id)

    // 模拟破坏
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dependencies: { 'broken-pkg': '^2.0.0' } }), 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '$patch:\n  - insert: [broken-pkg]\n', 'utf8')

    // 恢复
    const restored = bm.restoreSnapshot('web', snap.id)
    assert.equal(restored, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MemoryEngine: 记录模式与上下文注入生成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-mem-test-'))
  try {
    const me = new MemoryEngine(dir)
    me.recordPattern({
      profile: 'agent-workspace',
      type: 'workflow',
      action: 'install_memory_stack',
      details: { stack: 'dsh-memory' },
      summary: '成功挂载了智能体记忆栈',
    })

    const all = me.getAllPatterns('agent-workspace')
    assert.equal(all.length, 1)
    assert.equal(all[0]?.type, 'workflow')

    const promptInject = me.buildContextInjection('agent-workspace')
    assert.ok(promptInject.includes('智能体记忆栈'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GodshService: 自动注册 4 大 Agent Tools 并响应调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-svc-test-'))
  try {
    const profileDir = join(dir, 'profiles', 'agent-workspace')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'agent-workspace', dependencies: {} }), 'utf8')

    const ctx = createMockContext()
    const svc = new GodshService(ctx, {
      profilesDir: join(dir, 'profiles'),
      backupDir: join(dir, 'backups'),
      memoryDir: join(dir, 'memory'),
    })

    const tools = svc.registerAgentTools()
    assert.equal(tools.length, 4)

    // 1. 测试 godsh_list_profiles
    const listTool = tools.find((t) => t.name === 'godsh_list_profiles')!
    const resList = (await listTool.handler({ filter: 'agent' })) as any[]
    assert.equal(resList.length, 1)
    assert.equal(resList[0]?.name, 'agent-workspace')

    // 2. 测试 godsh_workflow_execute
    const wfTool = tools.find((t) => t.name === 'godsh_workflow_execute')!
    const resWf = (await wfTool.handler({ workflowId: 'ai-agent-suite', targetProfile: 'agent-workspace' })) as any
    assert.equal(resWf.ok, true)

    // 3. 测试 godsh_snapshot_backup
    const snapTool = tools.find((t) => t.name === 'godsh_snapshot_backup')!
    const resSnap = (await snapTool.handler({ action: 'create', profile: 'agent-workspace', tagOrId: 'test-tag' })) as any
    assert.equal(resSnap.ok, true)

    // 4. 测试 godsh_toggle_plugin_hot
    const hotTool = tools.find((t) => t.name === 'godsh_toggle_plugin_hot')!
    const resHot = (await hotTool.handler({ profile: 'agent-workspace', pluginId: 'cordis-plugin-eval', enabled: 'true' })) as any
    assert.equal(resHot.ok, true)
    assert.equal(resHot.enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: 标准入口挂载并暴露 ctx.godsh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godsh-apply-test-'))
  try {
    const ctx = createMockContext()
    apply(ctx, { profilesDir: dir })
    assert.ok(ctx['godsh'] instanceof GodshService)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
