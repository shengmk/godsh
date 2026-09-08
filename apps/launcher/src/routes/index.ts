import type { ApiHandler } from './types.js'
import { profilesHandler } from './profiles.js'
import { allocationsHandler } from './allocations.js'
import { marketHandler } from './market.js'
import { unifiedKernelHandler, kernelsHandler } from './kernels.js'
import { dshHandler } from './dsh.js'
import { settingsHandler } from './settings.js'
import { workflowsHandler } from './workflows.js'
import { vaultHandler } from './vault.js'
import { doctorHandler } from './doctor.js'
import { backupHandler } from './backup.js'
import { repairHandler } from './repair.js'
import { tasksHandler } from './tasks.js'

/** 所有 API 路由处理器（按声明顺序逐个尝试；第一个返回 true 即视为已处理）。 */
export const routeHandlers: ApiHandler[] = [
  doctorHandler,
  profilesHandler,
  allocationsHandler,
  vaultHandler,
  backupHandler,
  repairHandler,
  tasksHandler,
  marketHandler,
  unifiedKernelHandler,
  kernelsHandler,
  dshHandler,
  settingsHandler,
  workflowsHandler,
]

