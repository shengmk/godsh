import { useCallback, useMemo, useState } from 'react'

export type Locale = 'zh-CN' | 'en'

const STORAGE_KEY = 'dsh-launcher-locale'

const ZH: Record<string, string> = {
  'app.name': 'dsh Launcher',
  'app.subtitle': '环境配置启动器',
  'nav.dashboard': '仪表盘',
  'nav.dashboardDesc': '环境 / 插件 / 内核总览',
  'nav.profiles': '环境',
  'nav.profilesDesc': '启动 / 停止 / 日志',
  'nav.market': '插件市场',
  'nav.marketDesc': '搜索 / 安装插件',
  'nav.allocations': '插件分配',
  'nav.allocationsDesc': '拖拽分配插件',
  'nav.kernels': '内核管理',
  'nav.kernelsDesc': '模板 / 实例 / 统一内核',
  'nav.settings': '设置',
  'nav.settingsDesc': '主题 / 语言 / 路径',
  'nav.shortcut': 'Ctrl+1..7 切换页面',
  'nav.console': '控制台',
  'nav.consoleDesc': '快速启动默认模板',
  'nav.dshEnvs': 'DSH 环境',
  'nav.dshEnvsDesc': 'base / 并列环境',
  'page.console.title': '控制台',
  'page.console.desc': 'Controller Console —— 快速启动默认模板 / 状态总览',
  'page.dshEnvs.title': 'DSH 环境',
  'page.dshEnvs.desc': '管理 dsh 本体环境（base 主环境 + 并列环境），类比 Anaconda 的环境管理',
  'console.noDsh': '未检测到 dsh',
  'console.noDshHint': '可在「DSH 环境」页一键安装官方 dsh 建立 base 主环境，或直接点击下方「快速启动」自动完成。',
  'console.quickStart': '快速启动默认模板',
  'console.quickStartHint': '一键完成：无 dsh 自动安装 base → 初始化官方模板 → 启动默认 web 环境。',
  'console.quickStartBtn': '快速启动默认模板',
  'console.open': '打开',
  'console.ready': '默认模板已启动',
  'console.goEnvs': 'DSH 环境',
  'dash.dshVersion': 'dsh 版本',
  'topbar.search': '搜索环境 / 插件 / 内核…',
  'topbar.groupProfiles': '环境',
  'topbar.groupPlugins': '插件',
  'topbar.groupKernels': '内核',
  'topbar.start': '启动',
  'topbar.noResult': '无匹配结果',
  'page.dashboard.title': '仪表盘',
  'page.dashboard.desc': 'dsh Launcher 状态总览',
  'page.profiles.title': '环境',
  'page.profiles.desc': '管理 DSH Profile：启动 / 停止 / 查看日志',
  'page.market.title': '插件市场',
  'page.market.desc': '浏览并安装插件',
  'page.allocations.title': '插件分配',
  'page.allocations.desc': '把插件分配给环境：拖拽排序 / 跨环境移动 / 点选添加',
  'page.kernels.title': '内核管理',
  'page.kernels.desc': '内核模板 + 实例：所有 client 插件共享同一个 Web 内核',
  'page.settings.title': '设置',
  'page.settings.desc': '外观 / 路径 / 市场 / DSH 版本',
  'btn.refresh': '刷新',
  'btn.save': '保存设置',
  'btn.detect': '重新检测',
  'btn.setDefault': '设为默认',
  'common.active': '当前默认',
  'common.default': '默认',
  'common.restartNote': 'DSH 根目录 / 数据目录等路径改动需重启 Launcher 后生效。',
  'settings.appearance': '外观',
  'settings.theme': '主题',
  'settings.theme.light': '浅色',
  'settings.theme.dark': '深色',
  'settings.theme.system': '跟随系统',
  'settings.language': '语言',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.paths': '文件位置',
  'settings.dshHome': 'DSH 根目录',
  'settings.dataDir': '数据目录',
  'settings.logDir': '日志目录',
  'settings.templatesDir': '内核模板目录',
  'settings.pluginsDir': '本地插件目录',
  'settings.market': '插件市场',
  'settings.marketEnabled': '启用市场',
  'settings.marketUrl': '市场 URL',
  'settings.dshRuntime': 'DSH 运行时',
  'settings.dshRuntimeDesc': '检测并切换 dsh 版本：启动命令使用选定版本的绝对入口',
  'settings.detectedInstances': '检测到的 dsh 实例',
  'settings.noInstances': '未检测到 dsh 实例',
  'settings.extraDirs': '额外安装目录（每行一个包目录）',
  'settings.versionForProfile': '环境版本（默认 / 指定实例）',
  'settings.saved': '设置已保存',
  'settings.setDefaultDone': '已设为默认',
  'dash.running': '运行中环境',
  'dash.profiles': '环境总数',
  'dash.plugins': '本地插件',
  'dash.kernels': '内核实例',
  'dash.allocations': '分配关系',
  'dash.quick': '快捷操作',
  'dash.quickProfiles': '管理环境',
  'dash.quickMarket': '浏览市场',
  'dash.quickKernels': '管理内核',
  'dash.quickSettings': '打开设置',
  'dash.loading': '加载中…',
}

const EN: Record<string, string> = {
  'app.name': 'dsh Launcher',
  'app.subtitle': 'Environment Launcher',
  'nav.dashboard': 'Dashboard',
  'nav.dashboardDesc': 'Overview of env / plugins / kernels',
  'nav.profiles': 'Environments',
  'nav.profilesDesc': 'Start / Stop / Logs',
  'nav.market': 'Plugin Market',
  'nav.marketDesc': 'Search / Install',
  'nav.allocations': 'Allocations',
  'nav.allocationsDesc': 'Drag to assign plugins',
  'nav.kernels': 'Kernels',
  'nav.kernelsDesc': 'Templates / Instances / Unified kernel',
  'nav.settings': 'Settings',
  'nav.settingsDesc': 'Theme / Language / Paths',
  'nav.shortcut': 'Ctrl+1..7 to switch pages',
  'nav.console': 'Console',
  'nav.consoleDesc': 'Quick start default template',
  'nav.dshEnvs': 'DSH Envs',
  'nav.dshEnvsDesc': 'base / parallel envs',
  'page.console.title': 'Console',
  'page.console.desc': 'Controller Console — quick start / overview',
  'page.dshEnvs.title': 'DSH Environments',
  'page.dshEnvs.desc': 'Manage dsh runtimes (base + parallel), like Anaconda envs',
  'console.noDsh': 'dsh not detected',
  'console.noDshHint': 'Install official dsh as the base env in "DSH Envs", or just click Quick Start below.',
  'console.quickStart': 'Quick Start Default Template',
  'console.quickStartHint': 'One click: install base if missing → init official template → start default web env.',
  'console.quickStartBtn': 'Quick Start',
  'console.open': 'Open',
  'console.ready': 'Default template started',
  'console.goEnvs': 'DSH Envs',
  'dash.dshVersion': 'dsh version',
  'topbar.search': 'Search envs / plugins / kernels…',
  'topbar.groupProfiles': 'Environments',
  'topbar.groupPlugins': 'Plugins',
  'topbar.groupKernels': 'Kernels',
  'topbar.start': 'Start',
  'topbar.noResult': 'No matches',
  'page.dashboard.title': 'Dashboard',
  'page.dashboard.desc': 'dsh Launcher overview',
  'page.profiles.title': 'Environments',
  'page.profiles.desc': 'Manage DSH profiles: start / stop / view logs',
  'page.market.title': 'Plugin Market',
  'page.market.desc': 'Browse and install plugins',
  'page.allocations.title': 'Allocations',
  'page.allocations.desc': 'Assign plugins to environments: drag, move, click to add',
  'page.kernels.title': 'Kernels',
  'page.kernels.desc': 'Kernel templates + instances: one shared web kernel',
  'page.settings.title': 'Settings',
  'page.settings.desc': 'Appearance / Paths / Market / DSH versions',
  'btn.refresh': 'Refresh',
  'btn.save': 'Save Settings',
  'btn.detect': 'Re-detect',
  'btn.setDefault': 'Set Default',
  'common.active': 'Active',
  'common.default': 'Default',
  'common.restartNote': 'Changes to DSH root / data paths take effect after restarting the Launcher.',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.language': 'Language',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.paths': 'File Locations',
  'settings.dshHome': 'DSH Root',
  'settings.dataDir': 'Data Directory',
  'settings.logDir': 'Log Directory',
  'settings.templatesDir': 'Kernel Templates',
  'settings.pluginsDir': 'Local Plugins',
  'settings.market': 'Plugin Market',
  'settings.marketEnabled': 'Enable market',
  'settings.marketUrl': 'Market URL',
  'settings.dshRuntime': 'DSH Runtime',
  'settings.dshRuntimeDesc': 'Detect and switch dsh versions; start commands use the absolute entry of the selected version',
  'settings.detectedInstances': 'Detected dsh instances',
  'settings.noInstances': 'No dsh instance detected',
  'settings.extraDirs': 'Extra install directories (one package dir per line)',
  'settings.versionForProfile': 'Environment version (default / instance)',
  'settings.saved': 'Settings saved',
  'settings.setDefaultDone': 'Set as default',
  'dash.running': 'Running envs',
  'dash.profiles': 'Total envs',
  'dash.plugins': 'Local plugins',
  'dash.kernels': 'Kernel instances',
  'dash.allocations': 'Allocations',
  'dash.quick': 'Quick Actions',
  'dash.quickProfiles': 'Manage envs',
  'dash.quickMarket': 'Browse market',
  'dash.quickKernels': 'Manage kernels',
  'dash.quickSettings': 'Open settings',
  'dash.loading': 'Loading…',
}

const DICTS: Record<Locale, Record<string, string>> = { 'zh-CN': ZH, en: EN }

export function getLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export function setLocaleStore(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* ignore */
  }
}

export function translate(locale: Locale, key: string): string {
  return DICTS[locale][key] ?? DICTS['zh-CN'][key] ?? key
}

export function useI18n(): {
  locale: Locale
  t: (key: string) => string
  changeLocale: (l: Locale) => void
} {
  const [locale, setLocaleState] = useState<Locale>(getLocale)
  const t = useMemo(() => (key: string) => translate(locale, key), [locale])
  const changeLocale = useCallback((l: Locale) => {
    setLocaleStore(l)
    setLocaleState(l)
  }, [])
  return { locale, t, changeLocale }
}
