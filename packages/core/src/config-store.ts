import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LauncherConfig } from './types.js'
import { APP_VERSION } from './version.js'

const DEFAULT_CONFIG: LauncherConfig = {
  // 版本号来自唯一真源（根 package.json 的 version，见 ./version.ts），不再硬编码。
  // 此处曾写死一个旧版本号字面量，导致新版安装包的 /api/health 自报旧版本。
  launcher: { name: 'godsh', version: APP_VERSION },
  dsh: { home: '', bin: 'dsh', profilesDir: 'profiles', instances: {}, activeVersion: '', byProfile: {}, dirs: [] },
  runtime: { node: 'node', pnpm: 'pnpm' },
  webKernel: { defaultTemplateId: 'web-default', allowMultiPort: false },
  pluginMarket: { enabled: true, indexUrl: 'https://awesome-dsh-plugin.com/plugins.json' },
  // 默认白名单包含 Tauri 桌面端来源与本地固定开发/生产端口（避免泛 localhost 通配导致 CSRF 隐患）
  allowedOrigins: [
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
    'http://localhost:5173',
    'http://localhost:4780',
    'http://127.0.0.1:4780',
  ],
  dataDir: './data',
}

/**
 * 剔除已废弃的 `webKernel.defaultPort`（清单 ④ 的 U10）。
 *
 * 为什么删：它曾经被当成「Web 内核默认端口」的出口，但全仓检索确认**没有任何读取点** ——
 * 真正决定端口的是内核模板自己的 `defaultPort`（`kernel-process.ts`）以及每个环境记录的端口。
 * 留着它只会让人以为"改这个能生效"，属于会误导人的死配置。
 *
 * 为什么要显式剔除而不是只从默认值里删掉：老版本写下的 `data/config.json` 里可能仍带着它，
 * 若只删默认值，它会被对象展开原样带进 API 返回的配置里，等于"以为删了其实还在"。
 * 这里按已知字段重建，旧配置因此被静默忽略（不报错、不阻断启动）。
 */
function stripLegacyWebKernel(webKernel: LauncherConfig['webKernel']): LauncherConfig['webKernel'] {
  const { defaultTemplateId, allowMultiPort } = webKernel
  return { defaultTemplateId, ...(allowMultiPort === undefined ? {} : { allowMultiPort }) }
}

/**
 * JSON 数据文件读写（Launcher 自身的持久化），
 * 与 DSH 的 Profile 配置（package.json / cordis.patch.yml）严格区分。
 */
export class ConfigStore {
  readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  private filePath(name: string): string {
    return join(this.dataDir, name)
  }

  read<T>(name: string, fallback: T): T {
    const p = this.filePath(name)
    if (!existsSync(p)) return fallback
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  write<T>(name: string, value: T): void {
    const p = this.filePath(name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8')
  }

  readConfig(): LauncherConfig {
    const cfg = this.read<LauncherConfig>('config.json', DEFAULT_CONFIG)
    return {
      ...DEFAULT_CONFIG,
      ...cfg,
      // launcher 是应用元数据：版本号永远以内置默认值为准，
      // 不随用户 data/config.json 里残留的旧版本覆盖（升级后版本显示才正确）。
      launcher: { ...DEFAULT_CONFIG.launcher, name: cfg.launcher?.name ?? DEFAULT_CONFIG.launcher.name },
      dsh: {
        ...DEFAULT_CONFIG.dsh,
        ...cfg.dsh,
        instances: { ...DEFAULT_CONFIG.dsh.instances, ...(cfg.dsh?.instances ?? {}) },
        byProfile: { ...DEFAULT_CONFIG.dsh.byProfile, ...(cfg.dsh?.byProfile ?? {}) },
      },
      runtime: { ...DEFAULT_CONFIG.runtime, ...cfg.runtime },
      webKernel: stripLegacyWebKernel({ ...DEFAULT_CONFIG.webKernel, ...cfg.webKernel }),
      pluginMarket: { ...DEFAULT_CONFIG.pluginMarket, ...cfg.pluginMarket },
      // 用户未配置时回退默认白名单（必须含 Tauri 桌面端来源，否则前端跨域请求被浏览器拦截 → failed to fetch）
      allowedOrigins: Array.isArray(cfg.allowedOrigins)
        ? cfg.allowedOrigins.filter((x): x is string => typeof x === 'string')
        : DEFAULT_CONFIG.allowedOrigins,
    }
  }

  /** 写回 config.json（设置页使用；DSH 根目录/数据目录等改动需重启 Launcher 生效）。 */
  writeConfig(cfg: LauncherConfig): void {
    this.write('config.json', cfg)
  }
}
