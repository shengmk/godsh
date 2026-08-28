import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  DATA_DIR,
  findDshInstances,
  getPortStatus,
  startWeb,
  stopWeb,
  type EnvInfo,
} from '@dsh-launcher/core'
import {
  createProfile,
  removeProfile,
  scanProfiles,
  type ProfileInfo,
} from '@dsh-launcher/profile-manager'
import { scanLocalPlugins, type PluginInfo } from '@dsh-launcher/plugin-registry'
import { fetchMarketIndex, listInstalled, pluginAction, type MarketPlugin } from '@dsh-launcher/marketplace'
import { listTemplates, KernelManager, type KernelTemplate } from '@dsh-launcher/kernel-manager'
import { createContext } from './context.js'
import { startApiServer } from './server.js'

function fmtTool(label: string, v: EnvInfo['node']): string {
  if (!v.found) return `${label}: 未安装${v.error ? ` (${v.error})` : ''}`
  return `${label}: ${v.version ?? '?'}${v.path ? ` @ ${v.path}` : ''}`
}

function printEnv(env: EnvInfo): void {
  console.log('=== 环境检测 ===')
  console.log(fmtTool('node', env.node))
  console.log(fmtTool('pnpm', env.pnpm))
  console.log(fmtTool('dsh ', env.dsh))
  console.log(`DSH_HOME: ${env.dshHome}${env.dshHomeExists ? '' : ' (不存在)'}`)
  console.log(`profiles: ${env.profilesDir}${env.profilesDirExists ? '' : ' (不存在)'}`)
  if (env.errors.length) {
    console.log('问题:')
    for (const e of env.errors) console.log(`  - ${e}`)
  } else {
    console.log('状态: 全部就绪')
  }
}

function printProfiles(profiles: ProfileInfo[]): void {
  console.log(`=== Profiles（${profiles.length}）===`)
  for (const p of profiles) {
    if (p.error) {
      console.log(`- ${p.name}: 错误(${p.error})`)
      continue
    }
    const bundles = p.bundles.join(', ') || '(无)'
    const disabled = p.patchDisabled.length ? ` 禁用[${p.patchDisabled.join(', ')}]` : ''
    console.log(`- ${p.name}: bundles=[${bundles}] patch条目=${p.patchEntries}${disabled}`)
  }
}

function printPlugins(plugins: PluginInfo[]): void {
  console.log(`=== 本地插件（${plugins.length}）===`)
  for (const p of plugins) {
    const kind = p.kind === 'both' ? 'bundle+client' : p.kind
    console.log(`- ${p.name} v${p.version ?? '?'} [${kind}]`)
    if (p.bundlePatch) console.log(`    bundle.patch: ${p.bundlePatch}`)
    if (p.clientPlatform) console.log(`    client.platform: ${p.clientPlatform}`)
  }
}

function printKernels(templates: KernelTemplate[], instances: ReturnType<KernelManager['list']>): void {
  console.log(`=== 内核模板（${templates.length}）===`)
  for (const t of templates) {
    console.log(`- ${t.id} [${t.type}] ${t.name}${t.defaultPort ? ` (默认端口 ${t.defaultPort})` : ''}`)
  }
  console.log(`=== 内核实例（${instances.length}）===`)
  for (const k of instances) {
    console.log(`- ${k.name} [${k.status}] template=${k.templateId} profile=${k.profile ?? '-'} port=${k.port ?? '-'}`)
  }
}

function marketDescription(p: MarketPlugin): string | null {
  const d = p.description
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    for (const k of ['en', 'zh', 'zh-CN', 'description', 'summary']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return null
}

function showHelp(): void {
  console.log(`dsh Launcher CLI
用法: pnpm launcher <command> [args]

命令:
  detect                              检测运行环境
  profiles                            扫描 $DSH_HOME/profiles
  profile create <name>               新建 Profile
  profile remove <name>               删除 Profile
  plugins                             扫描本地 plugins/
  market                              拉取插件市场索引
  plugin <add|remove|update> <pkg> --profile <name>
                                      安装/卸载/更新插件
  start <profile> [--port <n>]        启动 dsh web（前台运行，Ctrl+C 停止）
  stop <profile> [--port <n>]         停止 dsh web（按 pid 文件）
  status [--port <n>]                 查询运行状态
  kernels                             内核模板与实例
  kernel create --template <id> --profile <name> [--port <n>] [--name <n>]
  kernel start|stop|remove <id>       管理内核实例
  unified-kernel                      查看统一内核配置（注入所有 Profile 的 Web 内核 + 偏好插件）
  unified-kernel on|off               启用/禁用统一内核（启用自动应用到全部 Profile，禁用自动还原）
  unified-kernel apply|revert         手动应用 / 还原到全部 Profile
  unified-kernel add <id> [--name <n>] 向统一内核添加插件（bundle，需可从 dsh 内置或已安装依赖解析）
  unified-kernel remove <id>          从统一内核移除插件
  unified-kernel enable|disable <id>  启用/禁用统一内核插件
  unified-kernel reorder <ids>        调整统一内核插件顺序（逗号分隔）
  dsh-envs                            查看 DSH 环境（base + 并列环境）
  dsh-envs add <name> [--version <spec>] 添加并列环境（npm --prefix 安装）
  dsh-envs remove <id>                删除并列环境
  dsh-envs activate <id>              设为默认
  dsh-install status                  查看 dsh 安装状态 / 最新版本
  dsh-install base [--version <spec>] 安装官方 dsh 为 base 主环境
  dsh-install init-home [--dshHome <dir>] 初始化 DSH_HOME + 官方默认模板
  reset [--all]                      重置数据（--all 同时删除所有 Profile 目录）
  settings                            查看 Launcher 配置与检测到的 dsh 版本
  allocate <profile> <pluginId> [--name <n>] [--disable]
                                      分配插件到 Profile
  allocations <profile>               查看 Profile 的分配关系
  apply <profile>                     把分配关系写入 cordis.patch.yml
  sync                                同步所有已分配 Profile 的 patch
  unallocate <id>                     移除一条分配关系
  serve [--port <n>]                  启动 HTTP API 服务（默认 4780）
  help                                显示帮助`)
}

interface Parsed {
  command: string
  positionals: string[]
  options: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Parsed {
  const command = argv[0] ?? 'help'
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        options[key] = next
        i++
      } else {
        options[key] = true
      }
    } else {
      positionals.push(a)
    }
  }
  return { command, positionals, options }
}

function optStr(opts: Record<string, string | boolean>, key: string): string | undefined {
  const v = opts[key]
  return typeof v === 'string' ? v : undefined
}

function optNum(opts: Record<string, string | boolean>, key: string): number | undefined {
  const v = optStr(opts, key)
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)
  const ctx = createContext()
  const { store, profilesDir, pidDir, logDir, pluginsDir, templatesDir, kernels, allocations, unifiedKernel, dshEnvs, sourcePolicy } = ctx

  /** 启动前把统一内核应用到某 Profile（幂等，保证无 web-app 也能出 UI）。 */
  function ensureUnifiedKernel(profile: string): void {
    const p = scanProfiles(profilesDir).find((x) => x.name === profile)
    if (p) unifiedKernel.applyToProfile(p)
  }

  /** 解析某 Profile 应使用的 dsh 版本（node 入口）；无配置返回 undefined（走 PATH 的 dsh）。 */
  function resolveDshBin(profile?: string): string | undefined {
    const cfg = store.readConfig()
    const name = (profile && cfg.dsh.byProfile?.[profile]) || cfg.dsh.activeVersion || ''
    if (!name) return undefined
    return cfg.dsh.instances?.[name]
  }

  switch (parsed.command) {
    case 'detect': {
      printEnv(ctx.env)
      break
    }

    case 'profiles': {
      printProfiles(scanProfiles(profilesDir))
      break
    }

    case 'profile': {
      const sub = parsed.positionals[0]
      const name = parsed.positionals[1]
      if (!sub || !name) throw new Error('用法: profile <create|remove> <name>')
      if (sub === 'create') {
        const dir = createProfile(profilesDir, name)
        console.log(`已创建 Profile: ${name} @ ${dir}`)
      } else if (sub === 'remove') {
        removeProfile(profilesDir, name)
        console.log(`已删除 Profile: ${name}`)
      } else {
        throw new Error(`未知子命令: ${sub}`)
      }
      break
    }

    case 'plugins': {
      printPlugins(scanLocalPlugins(pluginsDir))
      break
    }

    case 'market': {
      const config = store.readConfig()
      if (!config.pluginMarket.enabled) throw new Error('插件市场已在配置中禁用')
      console.log(`拉取插件索引: ${config.pluginMarket.indexUrl}`)
      const index = await fetchMarketIndex(config.pluginMarket.indexUrl)
      console.log(`=== 插件市场（${index.plugins.length}）===`)
      for (const p of index.plugins) {
        const version = typeof p.version === 'string' ? ` v${p.version}` : ''
        console.log(`- ${p.name}${version}${marketDescription(p) ? ` — ${marketDescription(p)}` : ''}`)
      }
      break
    }

    case 'plugin': {
      const sub = parsed.positionals[0]
      const pkg = parsed.positionals[1]
      const profile = optStr(parsed.options, 'profile')
      if (!sub || !profile) throw new Error('用法: plugin <add|remove|update|ls> [<pkg>] --profile <name>')

      if (sub === 'ls') {
        const r = await listInstalled(profile)
        if (r.stdout) console.log(r.stdout)
        if (r.stderr) console.error(r.stderr)
        if (!r.ok) throw new Error(`操作失败 (exit ${r.code})`)
        break
      }

      if (!pkg) throw new Error('用法: plugin <add|remove|update> <pkg> --profile <name>')
      if (!['add', 'remove', 'update'].includes(sub)) throw new Error(`未知动作: ${sub}`)

      const decision = sourcePolicy.check(pkg)
      if (!decision.allowed) throw new Error(`来源校验失败: ${decision.reason}`)

      console.log(`dsh plugin --profile ${profile} ${sub} ${pkg}`)
      const r = await pluginAction(profile, sub as 'add' | 'remove' | 'update', pkg)
      if (r.stdout) console.log(r.stdout)
      if (r.stderr) console.error(r.stderr)
      if (!r.ok) throw new Error(`操作失败 (exit ${r.code})`)
      console.log('完成')
      break
    }

    case 'start': {
      const profile = parsed.positionals[0]
      if (!profile) throw new Error('用法: start <profile> [--port <n>]')
      const port = optNum(parsed.options, 'port') ?? 3080
      ensureUnifiedKernel(profile)
      const dshBin = resolveDshBin(profile)
      if (dshBin) console.log(`dsh 版本: node ${dshBin}`)
      console.log(`启动 dsh web: profile=${profile} port=${port}（日志: ${logDir}）`)
      const { info } = await startWeb({
        profile,
        port,
        logDir,
        pidDir,
        dshBin,
        onLog: (line) => process.stdout.write(line),
      })
      console.log(`\n就绪: ${info.url}  pid=${info.pid}`)
      console.log('按 Ctrl+C 停止（或另开终端运行: pnpm launcher stop <profile>）')
      // 前台阻塞，直到子进程退出
      await new Promise(() => {})
      break
    }

    case 'stop': {
      const profile = parsed.positionals[0]
      const port = optNum(parsed.options, 'port') ?? 3080
      if (!profile) throw new Error('用法: stop <profile> [--port <n>]')
      const r = await stopWeb(pidDir, port)
      console.log(r.message)
      break
    }

    case 'status': {
      const port = optNum(parsed.options, 'port')
      if (port !== undefined) {
        const { running, pid } = await getPortStatus(pidDir, port)
        console.log(`端口 ${port}: ${running ? `运行中 (pid ${pid})` : '已停止'}`)
      } else {
        console.log('=== 运行状态 ===')
        for (const p of scanProfiles(profilesDir)) {
          // 默认端口来自 config，逐个检查会较慢，这里仅报告实例状态
          console.log(`- ${p.name}: 由内核实例管理`)
        }
        await kernels.refreshStatus()
        for (const k of kernels.list()) {
          console.log(`- 内核 ${k.name}: ${k.status}${k.pid ? ` (pid ${k.pid})` : ''}`)
        }
      }
      break
    }

    case 'kernels': {
      printKernels(listTemplates(templatesDir), kernels.list())
      break
    }

    case 'kernel': {
      const sub = parsed.positionals[0]
      if (sub === 'create') {
        const templateId = optStr(parsed.options, 'template')
        const profile = optStr(parsed.options, 'profile')
        if (!templateId) throw new Error('用法: kernel create --template <id> --profile <name> [--port <n>]')
        const inst = kernels.create({
          templateId,
          profile,
          port: optNum(parsed.options, 'port'),
          name: optStr(parsed.options, 'name'),
        })
        console.log(`已创建内核实例: ${inst.name} (id=${inst.id})`)
      } else if (sub === 'start' || sub === 'stop') {
        const id = parsed.positionals[1]
        if (!id) throw new Error(`用法: kernel ${sub} <id>`)
        let inst
        if (sub === 'start') {
          const target = kernels.get(id)
          if (target?.profile) ensureUnifiedKernel(target.profile)
          const dshBin = resolveDshBin(target?.profile)
          if (dshBin) console.log(`dsh 版本: node ${dshBin}`)
          inst = await kernels.start(id, dshBin)
        } else {
          inst = await kernels.stop(id)
        }
        console.log(`内核 ${inst.name}: ${inst.status}${inst.error ? ` (${inst.error})` : ''}`)
      } else if (sub === 'remove') {
        const id = parsed.positionals[1]
        if (!id) throw new Error('用法: kernel remove <id>')
        kernels.remove(id)
        console.log(`已删除内核实例: ${id}`)
      } else {
        throw new Error('用法: kernel <create|start|stop|remove> ...')
      }
      break
    }

    case 'unified-kernel': {
      const sub = parsed.positionals[0]
      if (!sub) {
        const cfg = unifiedKernel.read()
        console.log(`统一内核: ${cfg.enabled ? '启用' : '禁用'}（${cfg.plugins.length} 个插件）`)
        for (const p of cfg.plugins) {
          const label = p.name && p.name !== p.id ? ` (${p.name})` : ''
          console.log(`- ${p.id}${label} [${p.disabled ? '禁用' : '启用'}]`)
        }
        break
      }
      if (sub === 'on' || sub === 'off') {
        const cfg = unifiedKernel.setGlobalEnabled(sub === 'on')
        console.log(`统一内核已${sub === 'on' ? '启用' : '禁用'}`)
        if (sub === 'on') {
          const results = unifiedKernel.applyToAll(scanProfiles(profilesDir))
          const changed = results.filter((r) => r.added.length || r.error)
          console.log(`已应用到 ${changed.length} 个 Profile（${results.filter((r) => r.added.length).length} 个有变更）`)
        } else {
          const results = unifiedKernel.revertFromAll(scanProfiles(profilesDir))
          const changed = results.filter((r) => r.added.length || r.error)
          console.log(`已从 ${changed.length} 个 Profile 还原`)
        }
        break
      }
      if (sub === 'apply') {
        const results = unifiedKernel.applyToAll(scanProfiles(profilesDir))
        for (const r of results) {
          if (r.added.length) console.log(`  ${r.profile}: +${r.added.join(', ')}`)
          else if (r.error) console.log(`  ${r.profile}: ${r.error}`)
        }
        console.log('统一内核已应用到全部 Profile')
        break
      }
      if (sub === 'revert') {
        const results = unifiedKernel.revertFromAll(scanProfiles(profilesDir))
        for (const r of results) {
          if (r.added.length) console.log(`  ${r.profile}: -${r.added.join(', ')}`)
          else if (r.error) console.log(`  ${r.profile}: ${r.error}`)
        }
        console.log('统一内核已从全部 Profile 还原')
        break
      }
      if (sub === 'add') {
        const id = parsed.positionals[1]
        if (!id) throw new Error('用法: unified-kernel add <id> [--name <n>]')
        unifiedKernel.addPlugin(id, optStr(parsed.options, 'name'))
        console.log(`已添加 ${id} 到统一内核`)
        break
      }
      if (sub === 'remove') {
        const id = parsed.positionals[1]
        if (!id) throw new Error('用法: unified-kernel remove <id>')
        unifiedKernel.removePlugin(id)
        console.log(`已从统一内核移除 ${id}`)
        break
      }
      if (sub === 'enable' || sub === 'disable') {
        const id = parsed.positionals[1]
        if (!id) throw new Error(`用法: unified-kernel ${sub} <id>`)
        unifiedKernel.setEnabled(id, sub === 'enable')
        console.log(`统一内核插件 ${id} 已${sub === 'enable' ? '启用' : '禁用'}`)
        break
      }
      if (sub === 'reorder') {
        const ids = (parsed.positionals[1] ?? '').split(',').filter(Boolean)
        if (!ids.length) throw new Error('用法: unified-kernel reorder <id1,id2,...>')
        unifiedKernel.reorder(ids)
        console.log('已更新统一内核插件顺序')
        break
      }
      throw new Error(`未知子命令: ${sub}`)
    }

    case 'allocate': {
      const profile = parsed.positionals[0]
      const pluginId = parsed.positionals[1]
      if (!profile || !pluginId) throw new Error('用法: allocate <profile> <pluginId> [--name <n>] [--disable]')
      const a = allocations.allocate(profile, pluginId, optStr(parsed.options, 'name') ?? pluginId)
      if (parsed.options.disable) allocations.setEnabled(a.id, false)
      console.log(`已分配插件 ${pluginId} 到 Profile ${profile}（${parsed.options.disable ? '禁用' : '启用'}）`)
      console.log('cordis.patch.yml 预览:')
      console.log(allocations.serializeProfilePatch(profile))
      break
    }

    case 'allocations': {
      const profile = parsed.positionals[0]
      if (!profile) throw new Error('用法: allocations <profile>')
      const list = allocations.listByProfile(profile)
      console.log(`=== Profile "${profile}" 分配关系（${list.length}）===`)
      for (const a of list) {
        console.log(`- #${a.order} ${a.pluginId} [${a.enabled ? '启用' : '禁用'}]`)
      }
      break
    }

    case 'apply': {
      const profile = parsed.positionals[0]
      if (!profile) throw new Error('用法: apply <profile>')
      const path = allocations.applyProfile(profilesDir, profile)
      console.log(`已写入 cordis.patch.yml: ${path}`)
      break
    }

    case 'sync': {
      const profiles = [...new Set(allocations.list().map((a) => a.profile))]
      if (!profiles.length) throw new Error('没有任何分配关系，先运行 allocate')
      for (const p of profiles) {
        const path = allocations.applyProfile(profilesDir, p)
        console.log(`已同步 ${p}: ${path}`)
      }
      break
    }

    case 'unallocate': {
      const id = parsed.positionals[0]
      if (!id) throw new Error('用法: unallocate <id>')
      allocations.remove(id)
      console.log(`已移除分配关系: ${id}`)
      break
    }

    case 'dsh-envs': {
      const sub = parsed.positionals[0]
      if (!sub) {
        const cfg = store.readConfig()
        console.log(`=== DSH 环境（${dshEnvs.list().length}）===`)
        for (const e of dshEnvs.list()) {
          const active = cfg.dsh.activeVersion === `env:${e.id}` ? ' ← 默认' : ''
          console.log(`- [${e.kind}] ${e.id} v${e.version ?? '?'} @ ${e.dir || e.run}${active}`)
        }
        console.log(`激活: ${cfg.dsh.activeVersion || '(未设置，用 PATH dsh)'}`)
        break
      }
      if (sub === 'add') {
        const name = parsed.positionals[1]
        if (!name) throw new Error('用法: dsh-envs add <name> [--version <spec>]')
        const env = await dshEnvs.addManaged(name, optStr(parsed.options, 'version'))
        console.log(`已添加并列环境 ${env.id} v${env.version}`)
        break
      }
      if (sub === 'remove') {
        const id = parsed.positionals[1]
        if (!id) throw new Error('用法: dsh-envs remove <id>')
        dshEnvs.removeManaged(id)
        console.log(`已删除环境 ${id}`)
        break
      }
      if (sub === 'activate') {
        const id = parsed.positionals[1]
        if (!id) throw new Error('用法: dsh-envs activate <id>')
        const env = dshEnvs.activate(id)
        console.log(`已激活 ${env.id} v${env.version}`)
        break
      }
      throw new Error(`未知子命令: ${sub}`)
    }

    case 'dsh-install': {
      const sub = parsed.positionals[0] ?? 'status'
      if (sub === 'status') {
        const st = dshEnvs.status()
        console.log(`dsh 已安装: ${st.found ? '是' : '否'}`)
        console.log(`base 版本: ${st.baseVersion ?? '-'}`)
        console.log(`激活版本: ${st.activeVersion ?? '-'}`)
        console.log(`npm 最新: ${st.latestVersion ?? '（无法获取）'}`)
        break
      }
      if (sub === 'base') {
        const r = await dshEnvs.installBase(optStr(parsed.options, 'version'))
        console.log(`base 主环境就绪: ${r.command}`)
        break
      }
      if (sub === 'init-home') {
        const r = dshEnvs.initHome(optStr(parsed.options, 'dshHome'))
        console.log(`DSH_HOME: ${r.home}`)
        console.log(`profiles: ${r.profilesDir}`)
        console.log(`已创建: ${r.created.join(', ') || '（无）'}`)
        break
      }
      throw new Error(`未知子命令: ${sub}`)
    }

    case 'reset': {
      const scope = parsed.options.all ? 'all' : 'data'
      if (scope === 'all') {
        for (const p of scanProfiles(profilesDir)) {
          try {
            removeProfile(profilesDir, p.name)
          } catch {
            /* 忽略 */
          }
        }
      }
      const files = ['config.json', 'kernels.json', 'allocations.json', 'unified-kernel.json', 'dsh-envs.json']
      for (const f of files) {
        try {
          rmSync(join(DATA_DIR, f), { force: true })
        } catch {
          /* 忽略 */
        }
      }
      console.log(`已重置（scope=${scope}）`)
      break
    }

    case 'settings': {
      const cfg = store.readConfig()
      const instances = findDshInstances(cfg.dsh.dirs ?? [])
      console.log('=== Launcher 配置 ===')
      console.log(`DSH 根目录: ${cfg.dsh.home || '(未设置，用 DSH_HOME 或 ~/.dsh)'}`)
      console.log(`数据目录: ${cfg.dataDir}`)
      console.log(`市场: ${cfg.pluginMarket.enabled ? '启用' : '禁用'} ${cfg.pluginMarket.indexUrl}`)
      console.log(`默认 dsh 版本: ${cfg.dsh.activeVersion || '(PATH)'}`)
      console.log('=== 检测到的 dsh 实例 ===')
      if (!instances.length) console.log('（未检测到）')
      for (const inst of instances) {
        const active = cfg.dsh.activeVersion === inst.name ? ' ← 默认' : ''
        console.log(`- ${inst.name} v${inst.version ?? '?'} @ ${inst.path}${active}`)
      }
      if (Object.keys(cfg.dsh.byProfile ?? {}).length) {
        console.log('=== Profile 指定版本 ===')
        for (const [p, v] of Object.entries(cfg.dsh.byProfile ?? {})) console.log(`- ${p}: ${v}`)
      }
      break
    }

    case 'serve': {
      const port = optNum(parsed.options, 'port') ?? 4780
      await startApiServer(ctx, { port })
      break
    }

    case 'help':
    default: {
      showHelp()
      break
    }
  }
}

main().catch((err) => {
  console.error(`\n[错误] ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
