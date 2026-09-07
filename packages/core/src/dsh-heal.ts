import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, statSync, renameSync, symlinkSync, copyFileSync, readlinkSync, unlinkSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { findPidByPort } from './process-manager.js'
import type { DoctorReport, PreflightResult, HealOptions, HealthSeverity } from './types.js'

/**
 * 安全解除 Junction / 符号链接，绝对杜绝 rmSync({ recursive: true }) 穿透删除目标源目录内容！
 * 在 Windows 上，若目标为 Junction，使用 fs.unlinkSync 或 fs.rmdirSync（不带 recursive）可安全删除链接本体。
 */
export function safeUnlinkJunction(p: string): void {
  try {
    const lst = lstatSync(p)
    if (lst.isSymbolicLink() || (process.platform === 'win32' && lst.isDirectory())) {
      try {
        unlinkSync(p)
        return
      } catch {
        try {
          rmdirSync(p)
          return
        } catch {}
      }
    }
  } catch {
    // 可能是靶向失效的断链，尝试 unlink
    try {
      unlinkSync(p)
      return
    } catch {}
  }
  // 若到达此处，说明既不是符号链接也不是目录（可能是普通文件），以非递归安全移除
  try {
    rmSync(p, { recursive: false, force: true })
  } catch {
    // 绝对禁止 fallback 到 recursive: true，彻底杜绝穿透 Junction 抹杀物理源目录！
  }
}

/**
 * dsh 官方 bundle 自愈（DSH Desktop 0.1.1-rc.2 junction 断链修复）。
 *
 * 背景：DSH Desktop 把官方 bundle（@deepseek-ai/dsh-base 等）打进 app.asar，
 * 并在 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 建 Junction 指向
 * `...\resources\app.asar\node_modules\@deepseek-ai\<pkg>`。asar 是文件不是目录，
 * Node 的 existsSync 无法验证 asar 内路径 → 所有引用官方 bundle 的 profile 启动失败
 * （"plugin tree failed to load"）。
 *
 * 修复：检测断链后，用普通 Node 解析 asar 字节（asar 本身是普通文件，可整体读取），
 * 把 node_modules 全量提取为真实目录到固定缓存位置，再把 profiles/node_modules 下
 * 断链的 Junction 替换为指向提取目录（或直接让 profiles/node_modules 整体指向它）。
 * 提取仅首次发生（缓存目录存在即跳过），约 24s / 117MB。
 */

/**
 * 提取后的 node_modules 缓存根（%LOCALAPPDATA%\godsh\node_modules）。
 * 注意：必须是名为 node_modules 的真实装载点 —— 包的 ESM 依赖解析从该目录向上找
 * node_modules，若缓存不是 node_modules 名字（如 dsh-node-modules），realpath 后
 * 依赖解析失败（Cannot find package）。实测置于 %LOCALAPPDATA%\godsh\node_modules 后 ESM 正常。
 */
export function dshModulesCacheDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'godsh', 'node_modules')
}

/** 从 PATH/已知位置解析 DSH Desktop 的 app.asar 路径。 */
export function findDshDesktopAsar(): string | null {
  // 1) 环境变量显式指定（测试用）
  if (process.env.DSH_DESKTOP_ASAR) return process.env.DSH_DESKTOP_ASAR
  // 2) 常规安装路径
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app.asar'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', '..', 'app.asar'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  // 3) 从 dsh shim 解析（dsh.cmd → DSH Desktop.exe 路径）
  try {
    const shim = process.env.DSH_DESKTOP_SHIM ?? ''
    if (shim && existsSync(shim)) {
      const text = readFileSync(shim, 'utf8')
      const m = /"([^"]*DSH Desktop\.exe)"/.exec(text)
      if (m) {
        const asar = join(dirname(m[1]!), 'resources', 'app.asar')
        if (existsSync(asar)) return asar
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

interface AsarFile {
  size: number
  offset: string
  /** 原生二进制标记：真实文件在 app.asar.unpacked，不在 asar 数据区 */
  unpacked?: boolean
}

/** 解析 asar header，返回 { dataStart, flat: Record<路径, AsarFile> }。 */
export function parseAsar(buf: Buffer): { dataStart: number; flat: Map<string, AsarFile> } {
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.slice(16, 16 + jsonSize).toString('utf8')) as {
    files: Record<string, unknown>
  }
  const dataStart = 16 + jsonSize + ((4 - (jsonSize % 4)) % 4)
  const flat = new Map<string, AsarFile>()
  const walk = (files: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(files)) {
      const f = v as { files?: Record<string, unknown>; size?: number; offset?: string; unpacked?: boolean }
      if (f.files) walk(f.files, prefix + k + '/')
      else if (f.size !== undefined)
        flat.set(prefix + k, { size: f.size, offset: f.offset ?? '0', unpacked: f.unpacked === true })
    }
  }
  walk(header.files, '')
  return { dataStart, flat }
}

/**
 * 计算 app.asar 的指纹（用于检测 DSH Desktop 升级）。
 * 采用「文件大小 + mtime + 头部 4KB 内容 hash」组合：升级安装包必然改变
 * 大小或内容，能可靠识别版本变化；比全量 hash 快得多（只读前 4KB）。
 */
export function asarFingerprint(asarPath: string): string | null {
  try {
    const st = statSync(asarPath)
    const fd = readFileSync(asarPath)
    const head = fd.subarray(0, Math.min(fd.length, 4096))
    const size = st.size
    const mtime = st.mtimeMs
    // 简单 FNV-1a 32 位 hash
    let h = 0x811c9dc5
    for (const b of head) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return `${size}-${Math.round(mtime)}-${h.toString(16)}`
  } catch {
    return null
  }
}

/** 提取缓存目录中保存的 asar 指纹文件路径（`.asar-fingerprint`）。 */
export function asarFingerprintPath(cache: string): string {
  return join(cache, '.asar-fingerprint')
}

/**
 * 检查 DSH Desktop 是否升级过（当前 asar 指纹 ≠ 缓存记录的指纹）。
 * 若升级：返回 true，调用方应清除 `.complete` 标记强制重新提取，
 * 避免旧缓存与新版 dsh 不兼容导致环境启动失败。
 */
export function dshDesktopUpgraded(cache: string, asarPath: string): boolean {
  const cur = asarFingerprint(asarPath)
  if (!cur) return false
  const fpPath = asarFingerprintPath(cache)
  if (!existsSync(fpPath)) return false // 无记录（首次/旧缓存）：让正常提取流程写指纹
  try {
    const saved = readFileSync(fpPath, 'utf8').trim()
    return saved !== cur
  } catch {
    return false
  }
}

/**
 * 提取 asar 内 node_modules 到目标目录（全量，含 unpacked 原生二进制）。
 * 完整性用 `.complete` 标记文件判断：提取中断（无标记）时下次重新完整提取。
 * 若检测到 DSH Desktop 升级（asar 指纹变化），会自动忽略旧标记强制重提取。
 * unpacked 文件（sharp/koffi 等原生模块的 .node/.dll）不在 asar 数据区，
 * 需从同目录 `app.asar.unpacked/node_modules` 真实目录复制。
 * @returns 是否执行了提取
 */
export function extractAsarNodeModules(asarPath: string, dest: string): boolean {
  const marker = join(dest, '.complete')
  const upgraded = dshDesktopUpgraded(dest, asarPath)
  if (existsSync(marker) && !upgraded) return false
  if (upgraded) {
    // DSH Desktop 升级：清掉旧标记与旧指纹，强制全量重提取
    try {
      rmSync(marker, { force: true })
      rmSync(asarFingerprintPath(dest), { force: true })
    } catch {
      /* 忽略 */
    }
  }
  mkdirSync(dirname(dest), { recursive: true })
  // 先写临时目录（dest 同级，避免被 dest 替换操作连带删除），成功后再原子替换
  const tmp = join(dirname(dest), '.tmp-' + Date.now())
  mkdirSync(tmp, { recursive: true })
  // unpacked 文件源：app.asar 同目录的 app.asar.unpacked/node_modules
  const unpackedRoot = join(dirname(asarPath), 'app.asar.unpacked', 'node_modules')
  try {
    const buf = readFileSync(asarPath)
    const { dataStart, flat } = parseAsar(buf)
    let count = 0
    for (const [k, f] of flat) {
      if (!k.startsWith('node_modules/')) continue
      const rel = k.slice('node_modules/'.length)
      const target = join(tmp, rel)
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (f.unpacked) {
        // 原生二进制：从 unpacked 目录复制（真实文件）
        const srcFile = join(unpackedRoot, rel)
        try {
          copyFileSync(srcFile, target)
          count++
          continue
        } catch {
          // unpacked 源缺失则尝试从 asar 数据区（降级，通常失败但尽力）
        }
      }
      const off = Number(f.offset) + dataStart
      writeFileSync(target, buf.slice(off, off + f.size))
      count++
    }
    // 原子替换：把旧 dest 挪到备份，再 rename tmp -> dest
    const backup = join(dirname(dest), '.old-' + Date.now())
    if (existsSync(dest)) {
      try {
        renameSync(dest, backup)
      } catch {
        rmSync(dest, { recursive: true, force: true })
      }
    }
    try {
      renameSync(tmp, dest)
    } catch {
      // 跨卷/权限问题：退化为复制
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      copyDir(tmp, dest)
    }
    rmSync(backup, { recursive: true, force: true })
    // 记录当前 asar 指纹 + 完成标记
    writeFileSync(marker, new Date().toISOString())
    const fp = asarFingerprint(asarPath)
    if (fp) writeFileSync(asarFingerprintPath(dest), fp, 'utf8')
    return count > 0
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
}

/** 递归复制目录内容（rename 退化路径用）。 */
function copyDir(src: string, dest: string): void {
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dest, name)
    const lst = lstatSync(s)
    if (lst.isDirectory()) {
      mkdirSync(d, { recursive: true })
      copyDir(s, d)
    } else {
      writeFileSync(d, readFileSync(s))
    }
  }
}

/** 读取指定包目录下的 package.json 版本号。 */
export function readPkgVersion(pkgDir: string): string | null {
  try {
    const p = join(pkgDir, 'package.json')
    if (!existsSync(p)) return null
    const json = JSON.parse(readFileSync(p, 'utf8')) as { version?: string }
    return typeof json.version === 'string' ? json.version : null
  } catch {
    return null
  }
}

/**
 * 解析当前活跃的 DSH CLI 官方依赖目录（node_modules/@deepseek-ai）。
 * 优先使用实际执行环境（npm 全局 / 指定 bin 所在包），解决 DSH Desktop 内置版本与驱动 CLI 不匹配问题。
 */
export function resolveActiveDshNodeModules(activeDshBin?: string): string | null {
  const candidates: string[] = []
  if (activeDshBin && existsSync(activeDshBin)) {
    candidates.push(join(dirname(dirname(activeDshBin)), 'node_modules'))
    candidates.push(join(dirname(activeDshBin), 'node_modules'))
  }
  const appData = process.env.APPDATA ?? ''
  if (appData) {
    candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData) {
    candidates.push(join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'node_modules'))
  }
  for (const c of candidates) {
    if (c && existsSync(join(c, '@deepseek-ai', 'dsh-base'))) {
      return c
    }
  }
  return null
}

export interface DependencySource {
  sourceDir: string
  scopedDir: string
  isAsar: boolean
  version: string | null
}

/** 解析官方依赖源：优先实时驱动 CLI 的 node_modules，回退至 asar 提取缓存。 */
export function resolveOfficialDependencySource(activeDshBin?: string): DependencySource | null {
  const activeNm = resolveActiveDshNodeModules(activeDshBin)
  if (activeNm && existsSync(join(activeNm, '@deepseek-ai'))) {
    const scopedDir = join(activeNm, '@deepseek-ai')
    const version = readPkgVersion(join(scopedDir, 'dsh-base'))
    return {
      sourceDir: activeNm,
      scopedDir,
      isAsar: false,
      version,
    }
  }
  const asar = findDshDesktopAsar()
  if (asar) {
    const cache = dshModulesCacheDir()
    try {
      extractAsarNodeModules(asar, cache)
    } catch {}
    const scopedDir = join(cache, '@deepseek-ai')
    const version = existsSync(scopedDir) ? readPkgVersion(join(scopedDir, 'dsh-base')) : null
    return {
      sourceDir: cache,
      scopedDir,
      isAsar: true,
      version,
    }
  }
  return null
}

/** 检测某 profile 中官方 bundle 是否可解析（存在且为真实目录/有效链接）。 */
export function bundleResolvable(profileDir: string, pkg = '@deepseek-ai/dsh-base'): boolean {
  const dir = join(profileDir, 'node_modules', pkg)
  try {
    if (!existsSync(join(dir, 'package.json'))) return false
    const st = statSync(join(dir, 'package.json'))
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * 跨版本兼容性垫片（向下兼容官方在 0.1.2-rc.1 中被移除/更名的 API）：
 * 1. @deepseek-ai/dsh-settings: 补充 export { settingsNamespace, installSettingsSection, deepEqualJson }
 *    避免 dsh-web-search-pro, @anweat/dsh-browser, dsh-better-sidebar 等社区插件崩溃
 * 2. @deepseek-ai/dsh-llm: 补充 export { CallId }（ToolCallId 别名），避免 dsh-agy-link 崩溃
 * 3. undici: 为 undici 8 补充 lib/handler/wrap-handler.js 与 unwrap-handler.js，避免 jsdom 崩溃
 * 4. @deepseek-ai/dsh-client-connection: 补充 loopback（127.0.0.1/localhost）免 token 自动签名授权与 303 会话重定向，
 *    彻底根除从浏览器/godsh 打开 web 时提示 "dsh web authentication required; reopen the URL printed by dsh web." 的 401 拦截
 */
export function ensureCompatibilityShims(activeDshNodeModules?: string | null, profileNm?: string): number {
  let shimmed = 0
  const sources: string[] = []
  if (activeDshNodeModules && existsSync(activeDshNodeModules)) {
    sources.push(activeDshNodeModules)
  }
  const globalDsh = resolveActiveDshNodeModules()
  if (globalDsh && existsSync(globalDsh) && !sources.includes(globalDsh)) {
    sources.push(globalDsh)
  }
  const cacheDir = dshModulesCacheDir()
  if (existsSync(cacheDir) && !sources.includes(cacheDir)) {
    sources.push(cacheDir)
  }

  for (const src of sources) {
    // 1. @deepseek-ai/dsh-settings 补充 settingsNamespace 和 installSettingsSection
    const settingsIdx = join(src, '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
    if (existsSync(settingsIdx)) {
      try {
        let code = readFileSync(settingsIdx, 'utf8')
        let modified = false
        if (!code.includes('function settingsNamespace') && code.includes('parseSettingsNamespace')) {
          code = code.replace(
            /export\s*\{\s*SettingsConflictError[^}]*\};/,
            (match) => {
              return `function settingsNamespace(value) {\n  return parseSettingsNamespace(value);\n}\nfunction installSettingsSection(ctx, ns, schema, entry, hooks) {\n  ctx.inject(['settings'], (sctx) => {\n    const scope = sctx.settings.register(ns, schema, {\n      base: entry,\n      ...(hooks && hooks.validate !== void 0 ? { validate: hooks.validate } : {})\n    });\n    if (hooks && hooks.setSource) hooks.setSource(() => scope.get());\n    sctx.effect(() => () => {\n      if (isUnloading(ctx)) return;\n      if (hooks && hooks.setSource) hooks.setSource(() => entry);\n      if (hooks && hooks.onChange) hooks.onChange();\n    });\n    if (hooks && hooks.onChange) hooks.onChange();\n    scope.watch(() => {\n      if (isUnloading(ctx)) return;\n      if (hooks && hooks.onChange) hooks.onChange();\n    });\n  });\n}\n${match.replace('};', ', settingsNamespace, installSettingsSection, deepEqualJson };')}`
            }
          )
          modified = true
        } else if (!code.includes('installSettingsSection')) {
          code = code.replace(
            /export\s*\{\s*SettingsConflictError[^}]*\};/,
            (match) => {
              return `function installSettingsSection(ctx, ns, schema, entry, hooks) {\n  ctx.inject(['settings'], (sctx) => {\n    const scope = sctx.settings.register(ns, schema, {\n      base: entry,\n      ...(hooks && hooks.validate !== void 0 ? { validate: hooks.validate } : {})\n    });\n    if (hooks && hooks.setSource) hooks.setSource(() => scope.get());\n    sctx.effect(() => () => {\n      if (isUnloading(ctx)) return;\n      if (hooks && hooks.setSource) hooks.setSource(() => entry);\n      if (hooks && hooks.onChange) hooks.onChange();\n    });\n    if (hooks && hooks.onChange) hooks.onChange();\n    scope.watch(() => {\n      if (isUnloading(ctx)) return;\n      if (hooks && hooks.onChange) hooks.onChange();\n    });\n  });\n}\n${match.replace('};', ', installSettingsSection, deepEqualJson };')}`
            }
          )
          modified = true
        }
        if (modified) {
          writeFileSync(settingsIdx, code, 'utf8')
          shimmed++
        }
      } catch {}
    }

    // 2. @deepseek-ai/dsh-llm 补充 CallId 导出
    const llmIdx = join(src, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
    if (existsSync(llmIdx)) {
      try {
        let code = readFileSync(llmIdx, 'utf8')
        if (!code.includes('CallId') || (!code.includes('const CallId = ToolCallId') && !code.includes('function CallId'))) {
          code = code.replace(
            /export\s*\{\s*APP_IDENTITY,/,
            'const CallId = ToolCallId;\nexport { CallId, APP_IDENTITY,'
          )
          writeFileSync(llmIdx, code, 'utf8')
          shimmed++
        }
      } catch {}
    }

    // 3. @deepseek-ai/dsh-client-connection 注入 loopback 自动授权（免 token 拦截，彻底解决 401 认证拦截）
    const connIdx = join(src, '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')
    if (existsSync(connIdx)) {
      try {
        let code = readFileSync(connIdx, 'utf8')
        let modified = false
        if (!code.includes('/* godsh loopback auto-auth */') && code.includes('writeUnauthorized(req, res);')) {
          const authTarget = /if\s*\(\s*this\.isAuthenticated\(req\)\s*\)\s*return\s*true;\s*this\.writeUnauthorized\(req,\s*res\);/
          if (authTarget.test(code)) {
            code = code.replace(
              authTarget,
              `if (this.isAuthenticated(req)) return true;
\t\t/* godsh loopback auto-auth */
\t\tconst authority = requestAuthority(req.headers);
\t\tif (req.method === "GET" && url.pathname === "/" && authority !== void 0 && (authority.startsWith("127.0.0.1") || authority.startsWith("localhost") || authority.startsWith("[::1]"))) {
\t\t\tconst issuedAt = Date.now();
\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;
\t\t\tconst value = encodeCookie({
\t\t\t\tversion: COOKIE_PAYLOAD_VERSION,
\t\t\t\tauthority,
\t\t\t\tissuedAt,
\t\t\t\texpiresAt
\t\t\t}, this.secret);
\t\t\tres.writeHead(303, {
\t\t\t\t"cache-control": "no-store",
\t\t\t\t"location": "/",
\t\t\t\t"referrer-policy": "no-referrer",
\t\t\t\t"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))
\t\t\t});
\t\t\tres.end();
\t\t\treturn false;
\t\t}
\t\tthis.writeUnauthorized(req, res);`
            )
            modified = true
          }

          const rejectTarget = /requestRejection\(request\)\s*\{\s*if\s*\(!isTrustedApiRequest\(request,\s*this\.trustedHosts\)\)\s*return\s*403;\s*return\s*this\.browserAuth\.isAuthenticated\(request\)\s*\?\s*void 0\s*:\s*401;\s*\}/
          if (rejectTarget.test(code)) {
            code = code.replace(
              rejectTarget,
              `requestRejection(request) {
\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
\t\tif (this.browserAuth.isAuthenticated(request)) return void 0;
\t\t/* godsh loopback auto-auth */
\t\tconst authority = requestAuthority(request.headers);
\t\tif (authority !== void 0 && (authority.startsWith("127.0.0.1") || authority.startsWith("localhost") || authority.startsWith("[::1]"))) {
\t\t\treturn void 0;
\t\t}
\t\treturn 401;
\t}`
            )
            modified = true
          }
        }
        if (modified) {
          writeFileSync(connIdx, code, 'utf8')
          shimmed++
        }
      } catch {}
    }
  }

  // 4. 检查并补充 undici 8 的 wrap-handler.js 与 unwrap-handler.js（若 profile 存在且使用了 jsdom）
  if (profileNm && existsSync(profileNm)) {
    const undiciHandlerDir = join(profileNm, 'undici', 'lib', 'handler')
    if (existsSync(undiciHandlerDir)) {
      const wrapPath = join(undiciHandlerDir, 'wrap-handler.js')
      const unwrapPath = join(undiciHandlerDir, 'unwrap-handler.js')
      if (!existsSync(wrapPath)) {
        try {
          const wrapContent = `'use strict'\nconst kHandler = Symbol.for('undici.handler')\nclass WrapHandler {\n  constructor(h) { this[kHandler] = h }\n  static wrap(h) { return new WrapHandler(h) }\n  onConnect(...a) { return this[kHandler].onConnect?.(...a) }\n  onError(...a) { return this[kHandler].onError?.(...a) }\n  onUpgrade(...a) { return this[kHandler].onUpgrade?.(...a) }\n  onResponseStarted(...a) { return this[kHandler].onResponseStarted?.(...a) }\n  onHeaders(...a) { return this[kHandler].onHeaders?.(...a) }\n  onData(...a) { return this[kHandler].onData?.(...a) }\n  onComplete(...a) { return this[kHandler].onComplete?.(...a) }\n  onBodySent(...a) { return this[kHandler].onBodySent?.(...a) }\n}\nmodule.exports = WrapHandler\n`
          writeFileSync(wrapPath, wrapContent, 'utf8')
          shimmed++
        } catch {}
      }
      if (!existsSync(unwrapPath)) {
        try {
          const unwrapContent = `'use strict'\nconst kHandler = Symbol.for('undici.handler')\nclass UnwrapHandler {\n  static unwrap(h) { return h && h[kHandler] ? h[kHandler] : h }\n}\nmodule.exports = UnwrapHandler\n`
          writeFileSync(unwrapPath, unwrapContent, 'utf8')
          shimmed++
        } catch {}
      }
    }
  }

  return shimmed
}

/**
 * 启动前依赖完整性与版本预检（P2 原则）：
 * 验证官方 bundle 可解析、关键子路径导出存在（防 ERR_PACKAGE_PATH_NOT_EXPORTED）、版本一致性。
 */
export function verifyProfileDeps(profileDir: string, activeDshBin?: string): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) {
    return { ok: false, problems: ['profile node_modules 目录不存在'] }
  }

  // 1. 官方 bundle 是否可解析
  if (!bundleResolvable(profileDir)) {
    problems.push('官方 bundle (@deepseek-ai/dsh-base) 不可解析')
  }

  // 2. 顶层依赖非空检查
  for (const pkg of ['commander', 'ws']) {
    const d = join(nm, pkg)
    if (existsSync(d)) {
      try {
        if (readdirSync(d).length === 0) {
          problems.push(`依赖包已被清空: ${pkg}`)
        }
      } catch {
        problems.push(`依赖包不可读: ${pkg}`)
      }
    }
  }

  // 3. 关键包与导出检查（防 ERR_PACKAGE_PATH_NOT_EXPORTED）
  const subagentPkgPath = join(nm, '@deepseek-ai', 'dsh-tool-subagent', 'package.json')
  if (existsSync(subagentPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(subagentPkgPath, 'utf8')) as {
        version?: string
        exports?: Record<string, unknown>
      }
      const exp = pkg.exports
      const source = resolveOfficialDependencySource(activeDshBin)
      const isNewDsh = source?.version ? !source.version.startsWith('0.1.1') : true
      if (isNewDsh && exp && typeof exp === 'object' && !('./model-selection-settings' in exp)) {
        problems.push(
          `官方依赖版本过旧: dsh-tool-subagent@${pkg.version ?? 'unknown'} 未导出 ./model-selection-settings (需要 >=0.1.2-rc.1 依赖)`
        )
      }
    } catch {
      problems.push('dsh-tool-subagent package.json 损坏')
    }
  }

  // 4. 兼容性垫片校验与自动自愈（向下兼容 API）
  const source = resolveOfficialDependencySource(activeDshBin)
  ensureCompatibilityShims(source?.sourceDir, nm)

  // 5. 版本一致性检查
  if (source && source.version) {
    const curBase = readPkgVersion(join(nm, '@deepseek-ai', 'dsh-base'))
    if (curBase && curBase !== source.version) {
      problems.push(`基座包版本不匹配: @deepseek-ai/dsh-base 当前为 ${curBase}，驱动 CLI 需要 ${source.version}`)
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * 修复 profile 的官方 bundle 依赖：对每个 profile 的 `node_modules` 建完整镜像
 * （@deepseek-ai 全部包 + 顶层依赖包），优先指向活跃驱动 CLI 的依赖，保障版本一致性。
 * @returns { healed: number; message: string }
 */
export function healProfilesNodeModules(dshHome: string, force = false, activeDshBin?: string, targetProfile?: string): { healed: number; message: string } {
  const source = resolveOfficialDependencySource(activeDshBin)
  if (!source) {
    return { healed: 0, message: '未找到官方依赖来源（既无 active node_modules 也无 app.asar）' }
  }

  // 确保官方依赖源已注入向下兼容垫片（settingsNamespace, installSettingsSection, CallId 等）
  ensureCompatibilityShims(source.sourceDir)

  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return { healed: 0, message: 'profiles 目录不存在' }
  if (!existsSync(source.scopedDir)) return { healed: 0, message: '依赖源缺少 @deepseek-ai 命名空间' }

  // 收集源里的 @deepseek-ai 包名 + 顶层依赖包名
  const scopedNames = readdirSync(source.scopedDir).filter((n) => {
    try {
      return statSync(join(source.scopedDir, n)).isDirectory()
    } catch {
      return false
    }
  })
  const topNames = readdirSync(source.sourceDir)
    .filter((n) => !n.startsWith('@') && !n.startsWith('.') && !n.endsWith('.tmp'))
    .filter((n) => {
      try {
        return statSync(join(source.sourceDir, n)).isDirectory()
      } catch {
        return false
      }
    })

  let healed = 0
  const allProfiles = readdirSync(profilesDir).filter((name) => {
    try {
      return statSync(join(profilesDir, name)).isDirectory() && name !== 'node_modules'
    } catch {
      return false
    }
  })
  const profiles = targetProfile ? allProfiles.filter((p) => p === targetProfile) : allProfiles

  for (const profile of profiles) {
    const profileNm = join(profilesDir, profile, 'node_modules')
    const scopedLink = join(profileNm, '@deepseek-ai')
    mkdirSync(scopedLink, { recursive: true })

    // @deepseek-ai 包：检查存在性、链接目标及版本一致性
    for (const name of scopedNames) {
      const src = join(source.scopedDir, name)
      const link = join(scopedLink, name)
      let needsHeal = force

      if (!needsHeal) {
        if (!existsSync(join(link, 'package.json'))) {
          needsHeal = true
        } else {
          // 校验版本是否与源一致
          const curVer = readPkgVersion(link)
          const srcVer = readPkgVersion(src)
          if (curVer && srcVer && curVer !== srcVer) {
            needsHeal = true
          } else {
            // 校验链接目标是否失效或断裂
            const target = readlinkSafe(link)
            if (target && target !== src) {
              needsHeal = true
            }
          }
        }
      }

      if (needsHeal) {
        try {
          safeUnlinkJunction(link)
          symlinkSync(src, link, 'junction')
          healed++
        } catch {
          /* 单包失败不阻断 */
        }
      }
    }

    // 顶层依赖包（仅当缺失或被清空时按需补全，避免冗余 unlink/link 磁盘开销）
    for (const name of topNames) {
      const src = join(source.sourceDir, name)
      const link = join(profileNm, name)
      let emptyOrMissing = !existsSync(join(link, 'package.json'))
      if (!emptyOrMissing) {
        try {
          if (readdirSync(link).length === 0) emptyOrMissing = true
        } catch {
          emptyOrMissing = true
        }
      }
      if (emptyOrMissing) {
        try {
          safeUnlinkJunction(link)
          symlinkSync(src, link, 'junction')
          healed++
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  const srcLabel = source.isAsar ? 'DSH Desktop asar' : `驱动 CLI (${source.version ?? '最新'})`
  if (healed > 0) {
    return { healed, message: `已同步并更新 ${healed} 个官方依赖链接（来源: ${srcLabel}）` }
  }
  return { healed: 0, message: `官方依赖正常（来源: ${srcLabel}）` }
}

/** 递归读取软链接目标（安全不抛错）。 */
function readlinkSafe(p: string): string | null {
  try {
    return readlinkSync(p)
  } catch {
    return null
  }
}

/** 便捷入口：调用一次自愈（server 启动 / profile start 前）。 */
export function ensureDshBundles(dshHome: string, activeDshBin?: string): { healed: number; message: string } {
  const profilesDir = join(dshHome, 'profiles')
  let anyBroken = false
  try {
    for (const name of readdirSync(profilesDir)) {
      if (name === 'node_modules') continue
      const dir = join(profilesDir, name)
      if (!statSync(dir).isDirectory()) continue
      const v = verifyProfileDeps(dir, activeDshBin)
      if (!v.ok) {
        anyBroken = true
        break
      }
    }
  } catch {
    anyBroken = true
  }
  let healed = 0
  let message = 'bundle 可解析且版本一致'
  if (anyBroken) {
    const r = healProfilesNodeModules(dshHome, true, activeDshBin)
    healed = r.healed
    message = r.message
  }
  try {
    const prep = prepDshFallback(dshHome, activeDshBin)
    healed += prep
  } catch {}
  return { healed, message }
}

/**
 * 预建 dsh 平铺 fallback：确保 profiles/node_modules/@deepseek-ai/* 全部是指向
 * 活跃依赖源的 junction。
 * 幂等：已正确指向则跳过。
 */
export function prepDshFallback(dshHome: string, activeDshBin?: string): number {
  const source = resolveOfficialDependencySource(activeDshBin)
  if (!source || !existsSync(source.scopedDir)) return 0

  const fallback = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  mkdirSync(fallback, { recursive: true })
  let built = 0

  for (const name of readdirSync(source.scopedDir)) {
    let st: ReturnType<typeof statSync> | null = null
    try {
      st = statSync(join(source.scopedDir, name))
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    const link = join(fallback, name)
    const target = join(source.scopedDir, name)
    try {
      const lst = lstatSync(link)
      if (lst.isSymbolicLink() && readlinkSafe(link) === target) continue
    } catch {}
    try {
      safeUnlinkJunction(link)
      symlinkSync(target, link, 'junction')
      built++
    } catch {}
  }
  return built
}

/** 便捷入口：启动单个 profile 前调用（确保该 profile 的 bundle 就绪且版本匹配）。 */
export function ensureProfileBundles(dshHome: string, profile: string, activeDshBin?: string): { healed: number; message: string } {
  const dir = join(dshHome, 'profiles', profile)
  const v = verifyProfileDeps(dir, activeDshBin)
  if (v.ok) {
    prepDshFallback(dshHome, activeDshBin)
    return { healed: 0, message: 'bundle 可解析且版本一致' }
  }
  const r = healProfilesNodeModules(dshHome, true, activeDshBin, profile)
  prepDshFallback(dshHome, activeDshBin)
  return r
}

/**
 * 修复提取缓存中被 pnpm 清空的包目录（返回修复数）。
 * 优先以实际运行中的 npm 全局依赖源为校验基准；无活跃源时回退到 app.asar。
 */
export function ensureCacheIntegrity(activeDshBin?: string): { healed: number; message: string } {
  const activeSource = resolveActiveDshNodeModules(activeDshBin)
  const cache = dshModulesCacheDir()

  // 1) 优先使用实时驱动 CLI 的 node_modules 补全/修复缓存
  if (activeSource && existsSync(activeSource)) {
    mkdirSync(cache, { recursive: true })
    const scopedActive = join(activeSource, '@deepseek-ai')
    let healed = 0
    if (existsSync(scopedActive)) {
      const scopedCache = join(cache, '@deepseek-ai')
      mkdirSync(scopedCache, { recursive: true })
      for (const name of readdirSync(scopedActive)) {
        const dir = join(scopedCache, name)
        const src = join(scopedActive, name)
        let needsFix = !existsSync(dir) || !existsSync(join(dir, 'package.json'))
        if (!needsFix) {
          try {
            if (readdirSync(dir).length === 0) needsFix = true
          } catch {
            needsFix = true
          }
        }
        if (needsFix) {
          try {
            safeUnlinkJunction(dir)
            symlinkSync(src, dir, 'junction')
            healed++
          } catch {}
        }
      }
    }
    return { healed, message: healed > 0 ? `已从活跃依赖源修复 ${healed} 个缓存包` : '缓存完整' }
  }

  // 2) 回退至 app.asar 修复逻辑
  const asar = findDshDesktopAsar()
  if (!asar) return { healed: 0, message: '未找到官方依赖来源，跳过缓存完整性检查' }

  if (existsSync(cache) && dshDesktopUpgraded(cache, asar)) {
    try {
      const extracted = extractAsarNodeModules(asar, cache)
      return {
        healed: extracted ? 1 : 0,
        message: extracted ? `检测到 DSH Desktop 升级，已重建依赖缓存（${asarFingerprint(asar)?.slice(0, 12)}…）` : 'DSH Desktop 升级但缓存无需重建',
      }
    } catch (err) {
      return { healed: 0, message: `DSH Desktop 升级后重提取失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (!existsSync(cache)) {
    try {
      const extracted = extractAsarNodeModules(asar, cache)
      return { healed: extracted ? 1 : 0, message: extracted ? '缓存已重建' : '缓存已存在' }
    } catch (err) {
      return { healed: 0, message: `提取失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  try {
    const buf = readFileSync(asar)
    const { dataStart, flat } = parseAsar(buf)
    const unpackedRoot = join(dirname(asar), 'app.asar.unpacked', 'node_modules')
    const pkgDirs = new Set<string>()
    for (const k of flat.keys()) {
      if (!k.startsWith('node_modules/')) continue
      const rel = k.slice('node_modules/'.length)
      const parts = rel.split('/')
      pkgDirs.add(parts.length >= 3 && rel.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!)
    }
    let healed = 0
    for (const pkg of pkgDirs) {
      const dir = join(cache, pkg)
      if (!existsSync(dir)) continue
      let fileCount = 0
      try {
        fileCount = readdirSync(dir).length
      } catch {}
      const hasPkgJson = existsSync(join(dir, 'package.json'))
      if (hasPkgJson && fileCount > 0) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      mkdirSync(dir, { recursive: true })
      let wrote = 0
      for (const [k, f] of flat) {
        if (!k.startsWith(`node_modules/${pkg}/`)) continue
        const rel = k.slice('node_modules/'.length)
        const target = join(cache, rel)
        const d = dirname(target)
        if (!existsSync(d)) mkdirSync(d, { recursive: true })
        if (f.unpacked) {
          try {
            copyFileSync(join(unpackedRoot, rel), target)
            wrote++
            continue
          } catch {}
        }
        const off = Number(f.offset) + dataStart
        writeFileSync(target, buf.slice(off, off + f.size))
        wrote++
      }
      if (wrote > 0) healed++
    }
    return { healed, message: healed > 0 ? `已修复 ${healed} 个被清空的缓存包` : '缓存完整' }
  } catch (err) {
    return { healed: 0, message: `缓存完整性检查失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 递归解除目标目录下所有的 Junction / 符号链接，返回解除的数量。
 * 在重置环境或删除 Profile 前调用，构筑安全防穿透隔离屏障（Safe Reset Barrier），
 * 杜绝后续 rmSync 递归穿透至全局 npm 目录抹杀宿主 CLI！
 */
export function safePurgeProfileJunctions(targetDir: string): number {
  if (!existsSync(targetDir)) return 0
  let unlinked = 0

  function walk(current: string): void {
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const name of entries) {
      const fullPath = join(current, name)
      try {
        const lst = lstatSync(fullPath)
        if (lst.isSymbolicLink() || (process.platform === 'win32' && lst.isDirectory())) {
          safeUnlinkJunction(fullPath)
          unlinked++
        } else if (lst.isDirectory()) {
          walk(fullPath)
        }
      } catch {}
    }
  }

  walk(targetDir)
  return unlinked
}

/**
 * 扫描指定 node_modules 目录下的死软链（目标丢失的 Junction/Symlink）
 */
export function scanDeadJunctions(nmDir: string): string[] {
  if (!existsSync(nmDir)) return []
  const dead: string[] = []

  function checkItem(p: string, name: string): void {
    if (name.startsWith('.')) return // 忽略 .bin, .pnpm 等内部辅助目录
    try {
      const lst = lstatSync(p)
      if (lst.isSymbolicLink()) {
        const target = readlinkSafe(p)
        if (!target || !existsSync(p)) {
          dead.push(p)
        }
      } else if (process.platform === 'win32' && lst.isDirectory()) {
        const target = readlinkSafe(p)
        if (target !== null) {
          // 是 Junction 目录，校验其目标有效性
          if (!existsSync(p) || !existsSync(join(p, 'package.json'))) {
            dead.push(p)
          }
        }
      }
    } catch {
      dead.push(p)
    }
  }

  try {
    for (const name of readdirSync(nmDir)) {
      const full = join(nmDir, name)
      if (name.startsWith('@')) {
        try {
          for (const sub of readdirSync(full)) {
            checkItem(join(full, sub), `${name}/${sub}`)
          }
        } catch {}
      } else {
        checkItem(full, name)
      }
    }
  } catch {}

  return dead
}

/**
 * 扫描指定 node_modules 中直接指向宿主全局 CLI 的高危 Junction 风险
 */
export function scanCrossJunctionRisks(nmDir: string): string[] {
  if (!existsSync(nmDir)) return []
  const risks: string[] = []

  function checkRisk(p: string, name: string): void {
    try {
      const lst = lstatSync(p)
      if (lst.isSymbolicLink() || (process.platform === 'win32' && lst.isDirectory())) {
        const target = readlinkSafe(p)
        if (target && target.includes('npm/node_modules/@deepseek-ai/dsh/node_modules')) {
          risks.push(name)
        }
      }
    } catch {}
  }

  try {
    for (const name of readdirSync(nmDir)) {
      const full = join(nmDir, name)
      if (name.startsWith('@')) {
        try {
          for (const sub of readdirSync(full)) {
            checkRisk(join(full, sub), `${name}/${sub}`)
          }
        } catch {}
      } else {
        checkRisk(full, name)
      }
    }
  } catch {}

  return risks
}

/**
 * 诊断单个 Profile 的六层健康状态，返回结构化 DoctorReport
 */
export function diagnoseProfile(dshHome: string, profileName: string, expectedPort = 3080): DoctorReport {
  const profDir = join(dshHome, 'profiles', profileName)
  const nmDir = join(profDir, 'node_modules')
  let issuesFound = 0

  // Layer 0: CLI
  const globalCli = resolveActiveDshNodeModules()
  let cliOk = true
  let cliVer: string | null = null
  const cliProblems: string[] = []
  if (!globalCli || !existsSync(join(globalCli, 'commander', 'package.json'))) {
    cliOk = false
    cliProblems.push('宿主全局 DSH CLI 核心依赖 commander 损坏或缺失')
    issuesFound++
  } else {
    cliVer = readPkgVersion(join(globalCli, '@deepseek-ai', 'dsh-base'))
  }

  // Layer 1: Network
  const occupyingPid = findPidByPort(expectedPort)
  const isListening = occupyingPid !== null
  const pidFile = join(dshHome, `service-pid-${expectedPort}.txt`)
  let recordedPid = ''
  if (existsSync(pidFile)) {
    try {
      recordedPid = readFileSync(pidFile, 'utf8').trim()
    } catch {}
  }
  const isOrphan = isListening && recordedPid !== '' && String(occupyingPid) !== recordedPid
  if (isOrphan) issuesFound++

  // Layer 2: HTTP
  const httpOk = !isOrphan
  const httpStatusCode = isListening ? 200 : null

  // Layer 3: Config & Linter
  let packageJsonExists = false
  const invalidPlaceholders: string[] = []
  let bundleOrderOk = true
  const configProblems: string[] = []
  const pkgPath = join(profDir, 'package.json')

  if (existsSync(pkgPath)) {
    packageJsonExists = true
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      for (const [depName, depVal] of Object.entries(allDeps)) {
        if (/link:.*(\/absolute\/path|path\/to|<TODO>|<REPLACE)/.test(depVal)) {
          invalidPlaceholders.push(`${depName} -> ${depVal}`)
          configProblems.push(`包 ${depName} 包含非法占位符示例路径: ${depVal}`)
          issuesFound++
        }
      }
      const bundles = pkg.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) {
        bundleOrderOk = false
        configProblems.push('缺少 dsh.profile.bundles 配置')
        issuesFound++
      } else {
        const baseIdx = bundles.indexOf('@deepseek-ai/dsh-base')
        const webIdx = bundles.indexOf('@deepseek-ai/dsh-web-app')
        if (baseIdx === -1 || webIdx === -1 || webIdx <= baseIdx) {
          bundleOrderOk = false
          configProblems.push('bundles 中 dsh-web-app 必须排列在 dsh-base 之后')
          issuesFound++
        }
      }
    } catch (e: any) {
      configProblems.push(`package.json 解析失败: ${e.message}`)
      issuesFound++
    }
  } else {
    configProblems.push('缺少 package.json')
    issuesFound++
  }

  // Layer 4: Patch
  let patchExists = false
  let patchLength = 0
  const patchProblems: string[] = []
  const patchPath = join(profDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    patchExists = true
    try {
      patchLength = statSync(patchPath).size
      if (patchLength === 0) {
        patchProblems.push('cordis.patch.yml 文件大小为 0 字节，将导致 Cordis 闪退')
        issuesFound++
      }
    } catch {}
  }

  // Layer 5: Junctions
  const deadJunctions = scanDeadJunctions(nmDir)
  const crossJunctionRisks = scanCrossJunctionRisks(nmDir)
  issuesFound += deadJunctions.length

  const hasWebApp = existsSync(join(nmDir, '@deepseek-ai', 'dsh-web-app', 'package.json'))
  const junctionOk = deadJunctions.length === 0 && hasWebApp

  let overall: HealthSeverity = 'HEALTHY'
  if (!cliOk || invalidPlaceholders.length > 0 || !bundleOrderOk || !hasWebApp) {
    overall = 'CRITICAL'
  } else if (issuesFound > 0 || crossJunctionRisks.length > 0) {
    overall = 'WARNING'
  }

  return {
    timestamp: new Date().toISOString(),
    profile: profileName,
    expectedPort,
    dshHome,
    overall,
    issuesFound,
    autoFixed: 0,
    backupPath: null,
    layers: {
      layer0_cli: {
        ok: cliOk,
        version: cliVer,
        problems: cliProblems,
        fixed: 0,
      },
      layer1_network: {
        ok: !isOrphan,
        port: expectedPort,
        isListening,
        pid: occupyingPid,
        isOrphan,
      },
      layer2_http: {
        ok: httpOk,
        statusCode: httpStatusCode,
        error: null,
      },
      layer3_config: {
        ok: configProblems.length === 0,
        packageJsonExists,
        invalidPlaceholders,
        bundleOrderOk,
        problems: configProblems,
      },
      layer4_patch: {
        ok: patchProblems.length === 0,
        patchExists,
        patchLength,
        problems: patchProblems,
      },
      layer5_junctions: {
        ok: junctionOk,
        totalJunctions: deadJunctions.length + crossJunctionRisks.length,
        deadJunctions,
        crossJunctionRisks,
        fixed: 0,
      },
    },
  }
}

/**
 * 启动前 Pre-flight 毫秒级门禁拦截校验
 */
export function runPreflightCheck(dshHome: string, profileName: string, expectedPort = 3080): PreflightResult {
  const report = diagnoseProfile(dshHome, profileName, expectedPort)
  if (report.overall === 'CRITICAL') {
    let reason = '检测到严重配置或依赖隐患'
    if (!report.layers.layer0_cli.ok) reason = '宿主全局 DSH CLI 核心依赖损坏'
    else if (report.layers.layer3_config.invalidPlaceholders.length > 0) {
      reason = `package.json 包含无效示例占位符路径 (${report.layers.layer3_config.invalidPlaceholders[0]})`
    } else if (!report.layers.layer3_config.bundleOrderOk) {
      reason = 'dsh.profile.bundles 配置缺失或顺序错误'
    } else if (!report.layers.layer5_junctions.ok) {
      reason = '核心 Web 组件缺失或存在断链'
    }
    return {
      ok: false,
      reason,
      canAutoHeal: true,
      report,
    }
  }
  return {
    ok: true,
    canAutoHeal: false,
    report,
  }
}

/**
 * 执行指定 Profile 的安全原子自愈
 */
export function healProfile(
  dshHome: string,
  profileName: string,
  options: HealOptions = {},
  activeDshBin?: string
): { healed: number; report: DoctorReport } {
  let healed = 0
  const profDir = join(dshHome, 'profiles', profileName)
  const nmDir = join(profDir, 'node_modules')

  // 1. 解绑死软链
  if (options.unlinkDeadJunctions !== false && existsSync(nmDir)) {
    const dead = scanDeadJunctions(nmDir)
    for (const d of dead) {
      safeUnlinkJunction(d)
      healed++
    }
  }

  // 2. 修复 0 字节 patch
  if (options.fixPatch !== false) {
    const patchPath = join(profDir, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      try {
        if (statSync(patchPath).size === 0) {
          writeFileSync(patchPath, '[]\n', 'utf8')
          healed++
        }
      } catch {}
    }
  }

  // 3. 依赖自愈与 bundle 重建
  const bundleResult = healProfilesNodeModules(dshHome, false, activeDshBin, profileName)
  healed += bundleResult.healed

  // 4. 重测并生成报告
  const report = diagnoseProfile(dshHome, profileName)
  report.autoFixed = healed

  return { healed, report }
}


