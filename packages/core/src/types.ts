export interface ToolInfo {
  found: boolean
  path: string | null
  version: string | null
  error?: string
}

export interface EnvInfo {
  platform: NodeJS.Platform
  node: ToolInfo
  pnpm: ToolInfo
  dsh: ToolInfo
  dshHome: string
  dshHomeExists: boolean
  profilesDir: string
  profilesDirExists: boolean
  errors: string[]
}

export interface LauncherConfig {
  launcher: { name: string; version: string }
  dsh: {
    home: string
    bin: string
    profilesDir: string
    /** 已检测/配置的 dsh 实例：name → node 入口（可直接 `node <entry>` 运行） */
    instances?: Record<string, string>
    /** 默认使用的实例名（缺省用 PATH 里的 dsh） */
    activeVersion?: string
    /** 每个 Profile 指定的实例名覆盖（key = profile 名） */
    byProfile?: Record<string, string>
    /** 用户配置的额外 dsh 安装目录（package.json 目录） */
    dirs?: string[]
  }
  runtime: { node: string; pnpm: string }
  webKernel: {
    defaultTemplateId: string
    defaultPort: number
    /** 是否允许同一 Profile 在自定义多端口下并发运行（默认 false，严格单环境单端口互斥） */
    allowMultiPort?: boolean
  }
  pluginMarket: { enabled: boolean; indexUrl: string }
  /** 允许跨域访问 API 的来源（默认空 = 仅同源；例如 ["http://localhost:5173"]） */
  allowedOrigins?: string[]
  dataDir: string
}

export interface DshInstance {
  /** 实例标识（如 path:... / npm-global） */
  name: string
  /** 展示路径（shim 或包目录） */
  path: string
  /** 可直接 `node <run>` 运行的入口 */
  run: string
  version: string | null
}

export type HealthSeverity = 'HEALTHY' | 'WARNING' | 'CRITICAL'

export interface DoctorReport {
  timestamp: string
  profile: string
  expectedPort: number
  dshHome: string
  overall: HealthSeverity
  issuesFound: number
  autoFixed: number
  backupPath: string | null
  layers: {
    layer0_cli: {
      ok: boolean
      version: string | null
      problems: string[]
      fixed: number
    }
    layer1_network: {
      ok: boolean
      port: number
      isListening: boolean
      pid: number | null
      isOrphan: boolean
    }
    layer2_http: {
      ok: boolean
      statusCode: number | null
      error: string | null
    }
    layer3_config: {
      ok: boolean
      packageJsonExists: boolean
      invalidPlaceholders: string[]
      bundleOrderOk: boolean
      problems: string[]
    }
    layer4_patch: {
      ok: boolean
      patchExists: boolean
      patchLength: number
      problems: string[]
    }
    layer5_junctions: {
      ok: boolean
      totalJunctions: number
      deadJunctions: string[]
      crossJunctionRisks: string[]
      fixed: number
    }
  }
}

export interface PreflightResult {
  ok: boolean
  reason?: string
  canAutoHeal: boolean
  report: DoctorReport
}

export interface HealOptions {
  unlinkDeadJunctions?: boolean
  fixPatch?: boolean
  restoreCli?: boolean
  killOrphan?: boolean
  backup?: boolean
}

