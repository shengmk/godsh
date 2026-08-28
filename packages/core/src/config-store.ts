import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LauncherConfig } from './types.js'

const DEFAULT_CONFIG: LauncherConfig = {
  launcher: { name: 'dsh Launcher', version: '0.2.2' },
  dsh: { home: '', bin: 'dsh', profilesDir: 'profiles', instances: {}, activeVersion: '', byProfile: {}, dirs: [] },
  runtime: { node: 'node', pnpm: 'pnpm' },
  webKernel: { defaultTemplateId: 'web-default', defaultPort: 3080 },
  pluginMarket: { enabled: true, indexUrl: 'https://awesome-dsh-plugin.com/plugins.json' },
  allowedOrigins: [],
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
      allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins.filter((x): x is string => typeof x === 'string') : [],
    }
  }

  /** 写回 config.json（设置页使用；DSH 根目录/数据目录等改动需重启 Launcher 生效）。 */
  writeConfig(cfg: LauncherConfig): void {
    this.write('config.json', cfg)
  }
}
