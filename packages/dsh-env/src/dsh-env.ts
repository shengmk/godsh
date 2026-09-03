import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clearEnvDetectCache, findDshInstances, runSync, spawnCommand, type ConfigStore, type DshInstance } from '@godsh/core'
import { createProfile } from '@godsh/profile-manager'

export type DshEnvKind = 'base' | 'managed' | 'external'

export interface DshEnv {
  /** 稳定标识（base / managed-<name> / external-<index>） */
  id: string
  kind: DshEnvKind
  name: string
  /** 安装目录（npm -g 为全局目录或留空） */
  dir: string
  /** 可直接 `node <run>` 的入口 */
  run: string
  version: string | null
  /** 安装时的版本规格（managed 专用，如 @0.1.1-rc.1） */
  requested?: string
  /** external 来源标签（PATH / npm 全局 / 自定义目录） */
  source?: string
}

interface EnvFile {
  envs: { id: string; kind: DshEnvKind; name: string; dir: string; run: string; version: string | null; requested?: string }[]
}

const BASE_ID = 'base'

/** 获取可用的 npm 镜像源（优先尊重用户配置，默认注入 npmmirror 保证极速） */
export function resolveNpmRegistry(): string {
  return process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmmirror.com'
}

/**
 * DSH 环境管理（类比 Anaconda：base 主环境 + 并列 conda 环境；每个"环境"装一个 dsh 本体）。
 * - base：官方 dsh（npm 全局安装），自动安装建立；可重新安装 / 更新，不直接删除。
 * - managed：并列环境，`npm install --prefix <受管目录>` 安装到独立目录，可添加 / 删除。
 * - external：检测到的外部安装（PATH / npm / pnpm / 用户配置目录），只读。
 * 数据：data/dsh-envs.json（base + managed）；instances 表同步维护，供启动命令解析。
 */
export class DshEnvManager {
  private static FILE = 'dsh-envs.json'
  /** 检测结果短时缓存（避免每次轮询都探测版本/查 npm） */
  private static detectCache: { at: number; data: DshInstance[] } | null = null
  private static latestCache: { at: number; value: string | null } | null = null
  private static versionsCache: { at: number; value: string[] } | null = null

  public static invalidateCache(): void {
    DshEnvManager.detectCache = null
    DshEnvManager.latestCache = null
    DshEnvManager.versionsCache = null
    clearEnvDetectCache()
  }

  private detectedFresh(): DshInstance[] {
    const now = Date.now()
    if (DshEnvManager.detectCache && now - DshEnvManager.detectCache.at < 10000) {
      return DshEnvManager.detectCache.data
    }
    const data = findDshInstances(this.store.readConfig().dsh.dirs ?? [])
    DshEnvManager.detectCache = { at: now, data }
    return data
  }

  private latestFresh(): string | null {
    const now = Date.now()
    if (DshEnvManager.latestCache && now - DshEnvManager.latestCache.at < 120_000) {
      return DshEnvManager.latestCache.value
    }
    let latest: string | null = null
    try {
      const reg = resolveNpmRegistry()
      const r = runSync('npm', ['view', '@deepseek-ai/dsh', 'version', `--registry=${reg}`, '--fetch-timeout=4000'])
      latest = r.ok ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null
    } catch {
      latest = null
    }
    DshEnvManager.latestCache = { at: now, value: latest }
    return latest
  }

  private versionsFresh(): string[] {
    const now = Date.now()
    if (DshEnvManager.versionsCache && now - DshEnvManager.versionsCache.at < 120_000) {
      return DshEnvManager.versionsCache.value
    }
    let versions: string[] = []
    try {
      const reg = resolveNpmRegistry()
      const r = runSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json', `--registry=${reg}`, '--fetch-timeout=5000'])
      if (r.ok) {
        const v = JSON.parse(r.stdout) as unknown
        if (Array.isArray(v)) versions = v.filter((x): x is string => typeof x === 'string').slice(-20).reverse()
      }
    } catch {
      versions = []
    }
    DshEnvManager.versionsCache = { at: now, value: versions }
    return versions
  }

  constructor(
    private store: ConfigStore,
    private managedRoot: string,
  ) {}

  // ---------- 持久化 ----------

  private readManaged(): EnvFile['envs'] {
    return this.store.read<EnvFile>(DshEnvManager.FILE, { envs: [] }).envs
  }

  private saveManaged(envs: EnvFile['envs']): void {
    this.store.write(DshEnvManager.FILE, { envs })
  }

  private instanceName(id: string): string {
    return `env:${id}`
  }

  private syncInstance(env: DshEnv): void {
    const cfg = this.store.readConfig()
    cfg.dsh.instances![this.instanceName(env.id)] = env.run
    this.store.writeConfig(cfg)
  }

  private dropInstance(id: string): void {
    const cfg = this.store.readConfig()
    const key = this.instanceName(id)
    if (cfg.dsh.instances) delete cfg.dsh.instances[key]
    if (cfg.dsh.activeVersion === key) cfg.dsh.activeVersion = ''
    for (const p of Object.keys(cfg.dsh.byProfile ?? {})) {
      if (cfg.dsh.byProfile![p] === key) delete cfg.dsh.byProfile![p]
    }
    this.store.writeConfig(cfg)
  }

  /** 从包目录解析 node 入口。 */
  private packageEntry(dir: string): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
      const candidates = [bin ? join(dir, bin) : '', join(dir, 'lib', 'bin.js')]
      for (const c of candidates) if (c && existsSync(c)) return c
      return null
    } catch {
      return null
    }
  }

  // ---------- 列表 ----------

  /**
   * 自愈：若未注册 base 但检测到 dsh（npm 全局优先），自动注册为 base。
   * 解决重置/首启后 base 记录缺失导致版本"测不出来"的问题。
   */
  ensureBaseRegistered(): boolean {
    const managed = this.readManaged()
    if (managed.some((e) => e.kind === 'base')) return false
    const detected = this.detectedFresh()
    const global = detected.find((d) => d.name.startsWith('npm-')) ?? detected[0]
    if (!global) return false
    managed.push({
      id: BASE_ID,
      kind: 'base',
      name: 'base',
      dir: dirname(global.run),
      run: global.run,
      version: global.version,
    })
    this.saveManaged(managed)
    this.syncInstance({ id: BASE_ID, kind: 'base', name: 'base', dir: dirname(global.run), run: global.run, version: global.version })
    return true
  }

  /** 合并检测到的外部实例 + 持久化的 base/managed 环境。 */
  list(): DshEnv[] {
    this.ensureBaseRegistered()
    const cfg = this.store.readConfig()
    const out = new Map<string, DshEnv>()
    const add = (e: DshEnv) => {
      if (!e.run || out.has(e.id)) return
      out.set(e.id, e)
    }

    // 检测到的外部实例（PATH / npm / pnpm / 自定义目录）
    const detected = this.detectedFresh()
    detected.forEach((inst, i) => {
      const source = inst.name.startsWith('path:') ? 'PATH' : inst.name.startsWith('npm-') ? 'npm 全局' : 'pnpm 全局'
      add({ id: `external-${i}`, kind: 'external', name: inst.name, dir: dirname(inst.run), run: inst.run, version: inst.version, source })
    })

    // 持久化的 base + managed（重新探测版本；npm 全局可能已更新）
    for (const e of this.readManaged()) {
      const entry = e.run && existsSync(e.run) ? e.run : e.dir ? this.packageEntry(e.dir) : null
      if (!entry) continue
      let version = e.version
      if (e.kind === 'base') {
        const inst = detected.find((d) => d.run === entry)
        if (inst?.version) version = inst.version
      }
      add({ id: e.id, kind: e.kind, name: e.name, dir: e.dir, run: entry, version, requested: e.requested })
    }

    return [...out.values()]
  }

  /** 当前激活的环境（config.dsh.activeVersion 指向的 instance 名）。 */
  activeEnv(): DshEnv | null {
    const cfg = this.store.readConfig()
    const active = cfg.dsh.activeVersion
    if (!active) return null
    const env = this.list().find((e) => this.instanceName(e.id) === active)
    return env ?? null
  }

  // ---------- 激活 ----------

  activate(id: string): DshEnv {
    const env = this.list().find((e) => e.id === id)
    if (!env) throw new Error(`DSH 环境不存在: ${id}`)
    const cfg = this.store.readConfig()
    cfg.dsh.activeVersion = this.instanceName(id)
    this.store.writeConfig(cfg)
    return env
  }

  // ---------- 安装 / 并列环境 ----------

  /** 流式执行命令（npm 安装进度回传）。 */
  private runStreamed(
    cmd: string,
    args: string[],
    onLog?: (line: string) => void,
  ): Promise<{ ok: boolean; code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawnCommand(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const onData = (d: Buffer) => {
        const s = d.toString()
        output += s
        onLog?.(s)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('close', (code) => resolve({ ok: code === 0, code, output }))
    })
  }

  /** 安装官方 dsh 为 base 主环境（npm 全局）。 */
  async installBase(versionSpec?: string, onLog?: (line: string) => void): Promise<{ id: string; command: string }> {
    const spec = versionSpec ? `@deepseek-ai/dsh@${versionSpec}` : '@deepseek-ai/dsh'
    const reg = resolveNpmRegistry()
    onLog?.(`[godsh] 正在使用镜像源加速: ${reg}\n[godsh] 准备更新/安装 ${spec}...\n`)
    const args = [
      'install',
      '-g',
      spec,
      `--registry=${reg}`,
      '--fetch-timeout=60000',
      '--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs',
    ]
    const r = await this.runStreamed('npm', args, onLog)
    if (!r.ok) {
      onLog?.(`\n[godsh 错误诊断] 安装失败。\n1. 若提示 EPERM，请确保关闭后台正在运行的 dsh/node 进程；\n2. 尝试以管理员身份重新运行 godsh。\n`)
      throw new Error(`npm 安装失败: ${r.output}`)
    }
    DshEnvManager.invalidateCache()
    // 注册 base：找 npm 全局实例
    const detected = findDshInstances([])
    const global = detected.find((d) => d.name.startsWith('npm-')) ?? detected[0]
    if (!global) throw new Error('安装完成但未检测到 dsh，请检查 npm 全局目录')
    const managed = this.readManaged().filter((e) => e.kind !== 'base')
    managed.push({
      id: BASE_ID,
      kind: 'base',
      name: 'base',
      dir: dirname(global.run),
      run: global.run,
      version: global.version,
      requested: versionSpec,
    })
    this.saveManaged(managed)
    this.syncInstance({
      id: BASE_ID,
      kind: 'base',
      name: 'base',
      dir: dirname(global.run),
      run: global.run,
      version: global.version,
    })
    // 默认激活 base
    const cfg = this.store.readConfig()
    if (!cfg.dsh.activeVersion) {
      cfg.dsh.activeVersion = this.instanceName(BASE_ID)
      this.store.writeConfig(cfg)
    }
    return { id: BASE_ID, command: `npm ${args.join(' ')}` }
  }

  /** 添加并列环境（npm --prefix 安装到受管目录）。 */
  async addManaged(name: string, versionSpec?: string, onLog?: (line: string) => void): Promise<DshEnv> {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw new Error('环境名只能含字母/数字/-/_（≤32）')
    const existing = this.readManaged().find((e) => e.name === name)
    if (existing) throw new Error(`环境已存在: ${name}`)
    const dir = join(this.managedRoot, name)
    mkdirSync(dir, { recursive: true })
    const spec = versionSpec ? `@deepseek-ai/dsh@${versionSpec}` : '@deepseek-ai/dsh'
    const reg = resolveNpmRegistry()
    onLog?.(`[godsh] 正在使用镜像源加速: ${reg}\n[godsh] 准备创建并列环境 ${name} (${spec})...\n`)
    const args = [
      'install',
      '--prefix',
      dir,
      spec,
      `--registry=${reg}`,
      '--fetch-timeout=60000',
      '--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs',
    ]
    const r = await this.runStreamed('npm', args, onLog)
    if (!r.ok) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`npm 安装失败: ${r.output}`)
    }
    DshEnvManager.invalidateCache()
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = this.packageEntry(pkgDir)
    if (!entry) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error('安装完成但未找到 dsh 入口')
    }
    const ver = this.probeVersion(entry)
    const env: DshEnv = {
      id: `managed-${name}`,
      kind: 'managed',
      name,
      dir,
      run: entry,
      version: ver,
      requested: versionSpec,
    }
    const managed = this.readManaged()
    managed.push({ id: env.id, kind: 'managed', name, dir, run: entry, version: ver, requested: versionSpec })
    this.saveManaged(managed)
    this.syncInstance(env)
    return env
  }

  /** 删除并列环境（仅 managed；base 请用"重新安装/更新"）。 */
  removeManaged(id: string): void {
    const env = this.readManaged().find((e) => e.id === id)
    if (!env) throw new Error(`受管环境不存在: ${id}`)
    if (env.kind === 'base') throw new Error('base 主环境不可删除，请用「重新安装 / 更新」')
    rmSync(env.dir, { recursive: true, force: true })
    this.saveManaged(this.readManaged().filter((e) => e.id !== id))
    this.dropInstance(id)
  }

  // ---------- 基础模板 / 状态 ----------

  /** 初始化 DSH_HOME + 官方默认模板（web profile）。 */
  initHome(dshHome?: string): { home: string; profilesDir: string; created: string[] } {
    const cfg = this.store.readConfig()
    const home = dshHome || cfg.dsh.home || process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh')
    const profilesDir = join(home, cfg.dsh.profilesDir || 'profiles')
    mkdirSync(profilesDir, { recursive: true })
    const created: string[] = []
    const existing = existsSync(join(profilesDir, 'web', 'package.json'))
    if (!existing) {
      createProfile(profilesDir, 'web')
      created.push('profiles/web')
    }
    if (!cfg.dsh.home) {
      cfg.dsh.home = home
      this.store.writeConfig(cfg)
    }
    return { home, profilesDir, created }
  }

  probeVersion(runPath: string): string | null {
    const r = runSync('node', [runPath, '--version'])
    return r.ok ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null
  }

  /**
   * 当前状态：是否找到 dsh、当前使用版本（激活环境 → base → 首个检测）、base、npm 最新版本、检测数量。
   * 版本"测不出来"的修复：确保 base 自愈注册 + 给出"当前实际使用版本"。
   */
  status(): {
    found: boolean
    currentVersion: string | null
    baseVersion: string | null
    activeVersion: string | null
    latestVersion: string | null
    detectedCount: number
  } {
    this.ensureBaseRegistered()
    const envs = this.list()
    const base = envs.find((e) => e.kind === 'base')
    const active = this.activeEnv()
    const currentVersion = active?.version ?? base?.version ?? envs[0]?.version ?? null
    let latest: string | null = null
    latest = this.latestFresh()
    return {
      found: envs.length > 0,
      currentVersion,
      baseVersion: base?.version ?? null,
      activeVersion: active?.version ?? null,
      latestVersion: latest,
      detectedCount: envs.length,
    }
  }

  /** npm 已发布的 dsh 版本列表（供"添加并列环境"下拉选择）。 */
  publishedVersions(): string[] {
    return this.versionsFresh()
  }

  /** 卸载全局 dsh（base 主环境），并清除 base 记录。 */
  async uninstallBase(): Promise<{ ok: boolean; message: string }> {
    const r = await this.runStreamed('npm', ['uninstall', '-g', '@deepseek-ai/dsh'])
    this.saveManaged(this.readManaged().filter((e) => e.id !== BASE_ID))
    this.dropInstance(BASE_ID)
    return r.ok ? { ok: true, message: '已卸载全局 dsh' } : { ok: false, message: `卸载失败: ${r.output}` }
  }

  /** 仅清除 base 记录（不执行 npm 卸载；测试/安全路径用）。 */
  dropBaseRecord(): void {
    this.saveManaged(this.readManaged().filter((e) => e.id !== BASE_ID))
    this.dropInstance(BASE_ID)
  }

  /** 删除全部受管并列环境目录（重置 dsh 全删除用）。 */
  removeManagedRoot(): void {
    rmSync(this.managedRoot, { recursive: true, force: true })
  }

  /** 合并 DshInstance（供 settings 等既有接口复用）。 */
  detectedInstances(): DshInstance[] {
    return this.detectedFresh()
  }
}
