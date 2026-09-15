/**
 * 「安装即启用」—— 缺陷 2 的行为核心（方案分部 B）。
 *
 * 缺陷原话：「不理解为什么插件分配的时候必须要先"分配"再实现其他功能，应该是插件可以
 * 自动启动（本身就是启用的状态），而用户可以选择不启用，启用态才是标准态。」
 *
 * 根因（本项目实测）：`allocate()` 这个动作**不是业务语义**，它只是「把行写进
 * `<profile>/cordis.patch.yml`」的唯一入口。而安装路径（市场安装 / 沙箱注入）只做了物理
 * 挂载与 `package.json` 声明，**从不写补丁层**，于是插件处于「物理在、声明不在」的状态 ——
 * dsh 会忽略它，用户唯一能补救的动作就是去分配页点一下。
 *
 * 本模块把这一步自动化：**安装成功后立刻写入分配并落地补丁层**，使「启用」成为安装的
 * 默认结果；「禁用」保留为用户在分配页的显式选择（`setEnabled(false)` 会写 `disabled: true`）。
 *
 * 三条纪律
 * --------
 *  1. **绝不抛异常**：它跑在「安装已经成功」的路径上，启用失败不能把成功安装的响应变成
 *     失败 —— 只能如实把失败原因带回给前端（`applied:false` + `message`）。
 *  2. **官方资产不纳管**（不变量 I2）：官方包不写分配、不写补丁层。
 *  3. **幂等**：重复安装同一个包不会产生第二条分配记录（`allocate()` 本身幂等），
 *     若已存在但被禁用，则显式改回启用 —— 这正是「启用是标准态」的含义。
 *
 * @module @godsh/launcher/routes/auto-enable
 */

import { isOfficialPackage } from '@godsh/core'
import type { RouteContext } from './types.js'

/** 自动启用的结果（随安装响应回传，供前端如实显示）。 */
export interface AutoEnableResult {
  /** 是否已把该插件落到启用态并写回补丁层。 */
  applied: boolean
  /** 人类可读的中文说明（成功或失败都给出）。 */
  message: string
  /** 对应的分配记录 id（成功创建/命中时给出）。 */
  allocationId?: string
}

/**
 * 安装/注入成功之后，把插件落到**启用**态并写回 `cordis.patch.yml`。
 *
 * @param ctx - 路由上下文（需要 `allocations` 与 `tryApplyAllocation`）。
 * @param profile - 目标环境名。
 * @param pluginId - 插件包名（写成 patch 行的 id）。
 * @param pluginName - 展示名；缺省与包名相同。
 * @returns 结果对象；**任何情况下都不抛异常**。
 */
export function autoEnableAfterInstall(
  ctx: RouteContext,
  profile: string,
  pluginId: string,
  pluginName?: string,
): AutoEnableResult {
  try {
    if (typeof pluginId !== 'string' || pluginId.trim() === '') {
      return { applied: false, message: '包名为空，未自动启用' }
    }
    if (isOfficialPackage(pluginId)) {
      return { applied: false, message: '官方资产由 dsh 维护，godsh 不纳管（未写入分配与补丁层）' }
    }

    const before = ctx.allocations.list().find((a) => a.profile === profile && a.pluginId === pluginId)
    const allocation = ctx.allocations.allocate(profile, pluginId, pluginName ?? pluginId)
    // allocate() 对已存在的记录原样返回，所以「之前被禁用过」这一情形必须显式改回启用
    if (before !== undefined && before.enabled === false) {
      ctx.allocations.setEnabled(allocation.id, true)
    }

    const apply = ctx.tryApplyAllocation(profile)
    if (apply.applied) {
      return {
        applied: true,
        message: before === undefined ? '已自动启用（启用是标准态）' : '已恢复为启用',
        allocationId: allocation.id,
      }
    }
    return {
      applied: false,
      message: `插件已安装，但写回 cordis.patch.yml 失败：${apply.applyError ?? '未知原因'}。可到分配页手动启用`,
      allocationId: allocation.id,
    }
  } catch (err) {
    return { applied: false, message: `插件已安装，但自动启用失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
