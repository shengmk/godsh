#!/usr/bin/env node
/**
 * 检查 cordis HMR 的**前置条件**在这台机器上是否可能成立。
 *
 * 背景（dsh 源码）：
 *   - `cordis-plugin-hmr` 构造函数：`if (!this.ctx.loader.internal) throw new Error('--expose-internals is required for HMR service')`
 *   - `cordis-plugin-loader/lib/index.js:9-39`：
 *       function requireInternal(id) { if (process.execArgv.includes('--expose-internals')) try { ... } catch {} }
 *       function fromInternal() { const raw = requireInternal('internal/modules/esm/loader')?.getOrInitializeCascadedLoader(); ... }
 *
 * 也就是说，即使带上 `--expose-internals`，内容侧还有一次 `require('internal/modules/esm/loader')`
 * 与 `getOrInitializeCascadedLoader()` 的调用 —— 这两步在特定 Node 版本上可能整体失败并被
 * 静默 catch 成 undefined。若如此，则 **HMR 服务在本机永远无法构造，活层监听结构性不可用**，
 * 那么「常驻桥」就不是降级方案而是唯一路径。本脚本就是把这个钉死。
 *
 * 用法：node scripts/exp/check-hmr-prereq.mjs
 *       node --expose-internals scripts/exp/check-hmr-prereq.mjs
 */

import { createRequire } from 'node:module'

const out = {
  nodeVersion: process.version,
  execArgv: process.execArgv,
  flagPresent: process.execArgv.includes('--expose-internals'),
  guardWouldPass: false,
  requireInternalOk: false,
  requireInternalError: null,
  loaderKeys: null,
  cascadedLoaderType: null,
  cascadedLoaderError: null,
  verdict: [],
}

// ① 守卫：与 dsh 的实现逐字一致
if (out.flagPresent) {
  out.guardWouldPass = true
  const req = createRequire(import.meta.url)
  let raw = null
  try {
    raw = req('internal/modules/esm/loader')
    out.requireInternalOk = true
    out.loaderKeys = raw === null || raw === undefined ? null : Object.keys(raw).slice(0, 12)
  } catch (e) {
    out.requireInternalError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  if (raw !== null && raw !== undefined) {
    try {
      // dsh 调用的正是这个方法
      const factory = raw.getOrInitializeCascadedLoader ?? raw.default?.getOrInitializeCascadedLoader
      out.hasGetOrInitialize = typeof factory === 'function'
      if (typeof factory === 'function') {
        const cascaded = factory()
        out.cascadedLoaderType = typeof cascaded
      }
    } catch (e) {
      out.cascadedLoaderError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }
}

// ② 结论
if (!out.flagPresent) {
  out.verdict.push('未带 --expose-internals：守卫 process.execArgv.includes(...) 为 false，dsh 的 requireInternal 直接返回空 → HMR 不可用')
} else if (!out.requireInternalOk) {
  out.verdict.push(`带了 flag 但 require('internal/modules/esm/loader') 失败（${out.requireInternalError}）→ fromInternal() 会静默返回 undefined → HMR 仍不可用`)
} else if (out.cascadedLoaderError !== null) {
  out.verdict.push(`带了 flag 且能 require，但 getOrInitializeCascadedLoader() 抛错（${out.cascadedLoaderError}）→ fromInternal() 会静默返回 undefined → HMR 仍不可用`)
} else if (out.cascadedLoaderType === 'object' || out.cascadedLoaderType === 'function') {
  out.verdict.push('★ 带 flag 时本机可以拿到 cascaded loader → HMR 服务在构造层面**可能**成立；那么活层不生效的原因在别处（需继续查 watchUserPatches 的三条前置）')
} else {
  out.verdict.push('带 flag 但 cascaded loader 类型异常 → 需人工判读')
}

console.log(JSON.stringify(out, null, 2))
