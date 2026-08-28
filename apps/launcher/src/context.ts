import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ConfigStore,
  DATA_DIR,
  KERNEL_TEMPLATES_DIR,
  LOGS_DIR,
  PLUGINS_DIR,
  EventBus,
  detectEnvironment,
  type EnvInfo,
  type LauncherBus,
  type LauncherEvents,
} from '@dsh-launcher/core'
import { KernelManager, UnifiedKernelManager } from '@dsh-launcher/kernel-manager'
import { AllocationManager } from '@dsh-launcher/allocation'
import { DshEnvManager } from '@dsh-launcher/dsh-env'
import { SourcePolicy } from '@dsh-launcher/security'

export interface CliContext {
  store: ConfigStore
  bus: LauncherBus
  env: EnvInfo
  profilesDir: string
  pidDir: string
  logDir: string
  pluginsDir: string
  templatesDir: string
  kernels: KernelManager
  allocations: AllocationManager
  unifiedKernel: UnifiedKernelManager
  dshEnvs: DshEnvManager
  sourcePolicy: SourcePolicy
}

export function createContext(): CliContext {
  const store = new ConfigStore(DATA_DIR)
  const config = store.readConfig()
  // 兜底顺序：环境变量 DSH_HOME 优先 → config.json 的 dsh.home → ~/.dsh。
  // （config.json 里可能残留开发机的绝对路径，若优先会把它带到其它机器上。）
  const dshHome = process.env.DSH_HOME || config.dsh.home || join(homedir(), '.dsh')
  const profilesDir = join(dshHome, config.dsh.profilesDir || 'profiles')

  const bus: LauncherBus = new EventBus<LauncherEvents>()
  const env = detectEnvironment({ dshHome: dshHome || undefined })
  const pidDir = join(DATA_DIR, 'runtime')
  const logDir = LOGS_DIR

  return {
    store,
    bus,
    env,
    profilesDir,
    pidDir,
    logDir,
    pluginsDir: PLUGINS_DIR,
    templatesDir: KERNEL_TEMPLATES_DIR,
    kernels: new KernelManager(store, KERNEL_TEMPLATES_DIR, logDir, pidDir),
    allocations: new AllocationManager(store),
    unifiedKernel: new UnifiedKernelManager(store),
    dshEnvs: new DshEnvManager(store, join(DATA_DIR, 'dsh-envs')),
    sourcePolicy: new SourcePolicy(),
  }
}
