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
  webKernel: { defaultTemplateId: 'web-default', defaultPort: 3080, allowMultiPort: false },
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
      webKernel: { ...DEFAULT_CONFIG.webKernel, ...cfg.webKernel },
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
