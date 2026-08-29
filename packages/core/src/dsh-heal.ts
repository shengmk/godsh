import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, statSync, renameSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

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
      const f = v as { files?: Record<string, unknown>; size?: number; offset?: string }
      if (f.files) walk(f.files, prefix + k + '/')
      else if (f.size !== undefined && f.offset !== undefined) flat.set(prefix + k, { size: f.size, offset: f.offset })
    }
  }
  walk(header.files, '')
  return { dataStart, flat }
}

/**
 * 提取 asar 内 node_modules 到目标目录（全量）。
 * 完整性用 `.complete` 标记文件判断：提取中断（无标记）时下次重新完整提取。
 * @returns 是否执行了提取
 */
export function extractAsarNodeModules(asarPath: string, dest: string): boolean {
  const marker = join(dest, '.complete')
  if (existsSync(marker)) return false
  mkdirSync(dirname(dest), { recursive: true })
  // 先写临时目录（dest 同级，避免被 dest 替换操作连带删除），成功后再原子替换
  const tmp = join(dirname(dest), '.tmp-' + Date.now())
  mkdirSync(tmp, { recursive: true })
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
    writeFileSync(marker, new Date().toISOString())
    return count > 0
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
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
 * 修复 profile 的官方 bundle 依赖：对每个 profile 的 `node_modules` 建完整镜像
 * （@deepseek-ai 全部包 + 顶层依赖包），全部 junction 指向提取缓存。
 *
 * 背景：dsh CLI 从 profile 目录解析官方 bundle（@deepseek-ai/dsh-base 等）。
 * DSH Desktop 0.1.1-rc.2 把 junction 建在 `profiles/node_modules`（平铺 fallback），
 * 但 dsh 实际从 `profiles/<name>/node_modules` 解析 —— 且 junction 目标指向
 * `app.asar\node_modules`（asar 是文件，解析必然失败）。
 *
 * 本函数把官方包从 asar 提取到 `%LOCALAPPDATA%\godsh\node_modules`（真实 node_modules
 * 装载点，ESM 依赖解析正常），再在每个 profile 的 node_modules 建 junction 指向缓存。
 * @returns { healed: number; message: string }
 */
export function healProfilesNodeModules(dshHome: string, force = false): { healed: number; message: string } {
  // 1) 确保提取缓存存在
  const asar = findDshDesktopAsar()
  if (!asar) {
    return { healed: 0, message: '未找到 app.asar，无法修复 bundle' }
  }
  const cache = dshModulesCacheDir()
  let extracted = false
  try {
    extracted = extractAsarNodeModules(asar, cache)
  } catch (err) {
    return { healed: 0, message: `提取 node_modules 失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return { healed: 0, message: 'profiles 目录不存在' }
  const scopedCache = join(cache, '@deepseek-ai')
  if (!existsSync(scopedCache)) return { healed: 0, message: '缓存缺少 @deepseek-ai 命名空间' }

  // 收集缓存里的 @deepseek-ai 包名 + 顶层依赖包名
  const scopedNames = readdirSync(scopedCache).filter((n) => {
    try {
      return statSync(join(scopedCache, n)).isDirectory()
    } catch {
      return false
    }
  })
  const topNames = readdirSync(cache)
    .filter((n) => !n.startsWith('@') && !n.startsWith('.') && !n.endsWith('.tmp'))
    .filter((n) => {
      try {
        return statSync(join(cache, n)).isDirectory()
      } catch {
        return false
      }
    })

  let healed = 0
  const profiles = readdirSync(profilesDir).filter((name) => {
    try {
      return statSync(join(profilesDir, name)).isDirectory() && name !== 'node_modules'
    } catch {
      return false
    }
  })

  for (const profile of profiles) {
    const profileNm = join(profilesDir, profile, 'node_modules')
    const scopedLink = join(profileNm, '@deepseek-ai')
    mkdirSync(scopedLink, { recursive: true })
    // @deepseek-ai 包
    for (const name of scopedNames) {
      const src = join(scopedCache, name)
      const link = join(scopedLink, name)
      const resolvable = existsSync(join(link, 'package.json'))
      if (resolvable) continue
      try {
        rmSync(link, { recursive: true, force: true })
        symlinkSync(src, link, 'junction')
        healed++
      } catch {
        /* 单包失败不阻断 */
      }
    }
    // 顶层依赖包（只补缺失，不动已存在的用户包）
    for (const name of topNames) {
      const src = join(cache, name)
      const link = join(profileNm, name)
      if (existsSync(join(link, 'package.json'))) continue
      try {
        symlinkSync(src, link, 'junction')
        healed++
      } catch {
        /* 忽略 */
      }
    }
  }

  if (healed > 0 || extracted) {
    return { healed, message: `已修复 ${healed} 个断链（提取 ${extracted ? 'node_modules 缓存' : '已缓存'}）` }
  }
  return { healed: 0, message: '无断链，一切正常' }
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

/** 便捷入口：调用一次自愈（server 启动 / profile start 前）。 */
export function ensureDshBundles(dshHome: string): { healed: number; message: string } {
  const profilesDir = join(dshHome, 'profiles')
  // 任一 profile 的官方 bundle 不可解析则触发修复
  let anyBroken = false
  try {
    for (const name of readdirSync(profilesDir)) {
      if (name === 'node_modules') continue
      const dir = join(profilesDir, name)
      if (!statSync(dir).isDirectory()) continue
      if (!bundleResolvable(dir)) {
        anyBroken = true
        break
      }
    }
  } catch {
    anyBroken = true
  }
  if (!anyBroken) return { healed: 0, message: 'bundle 可解析' }
  return healProfilesNodeModules(dshHome)
}
