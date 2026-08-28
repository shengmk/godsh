# Release Notes — dsh Launcher v0.2.4

dsh 环境配置启动器（Anaconda Navigator 类比）—— 管理 DeepSeek Harness 的 Profile 环境、插件分配、Web 内核与 DSH 本体版本。

## 下载

| 文件 | 说明 |
| --- | --- |
| `dsh-launcher-0.2.4-x64-setup.exe` | Windows 安装器（NSIS，安装到 `%LOCALAPPDATA%\dsh-launcher`） |
| `dsh-launcher-0.2.4-x64.zip` | 便携版（解压后双击 `dsh-launcher.exe` 即可） |

校验和见同目录 `SHA256SUMS.txt`。

## v0.2.4 新增与修复

- **跨环境插件拖拽（真实鼠标可用）**：把已分配插件从 A 环境拖到 B 环境（如 plugin_bag → desktop），两个环境的 `cordis.patch.yml` 自动同步写回。
  - 拖拽改用 **Pointer Events 自研引擎**，彻底解决 WebView2 原生 HTML5 拖拽 drop 不触发的问题。
  - 可用插件（未分配）跨环境时需目标环境已安装该插件，否则提示先到市场安装。
- **同环境插件拖拽排序**：每个环境内「已分配卡片 + 可用插件」统一列表，全部可拖动排序。
- 版本号统一 0.2.4（package.json / Cargo / tauri.conf / config-store / config.json）。

## v0.2.3 新增与修复

- **插件拖拽全面修复**：所有插件（已分配 + 可用）统一列表、均可拖动。
  - 根因修复：dragstart 补 `setData`（Chromium/WebView2 缺它拖拽不启动）。
- **同环境内**：已分配排序、可用插件拖入分配、可用↔可用排序。

## v0.2.2 新增与修复

- **插件分配拖拽全面化**：可用插件拖拽区（拖入任意环境即分配）、跨环境移动、同环境排序。
- **插件市场批量安装**：多选 → 批量安装队列（进度 1/N）+ 热门/最新排序。
- **性能优化**：合并轮询 `/api/profiles/status?names=`、7 页 `React.lazy` 按页分包、市场 5 分钟缓存。
- **删除增强**：卡片 🗑️ 按钮 + 输入环境名确认 + 批量删除。
- **CORS 收紧 + 安全响应头**：默认仅同源，桌面端（tauri.localhost）白名单放行。
- **patch 写回守护**：含不可解析结构时拒绝写回并备份到 `data/patches-backup/`。
- **git 版本控制**：项目已纳入 git 管理。

## v0.2.1 修复（回顾）

dsh 版本显示自愈；并列环境版本下拉；重置新增 dsh 全删除；检测/npm 缓存；5 份审计文档。

## 核心功能（当前）

| 模块 | 能力 |
| --- | --- |
| 控制台 | 一键快速启动默认模板、状态总览 |
| 环境 | Profile 启动/停止/日志/打开、新建/删除、批量启停、端口占用视图、dsh 版本指定 |
| 插件市场 | 搜索、安装/更新/卸载、批量安装队列、热门/最新排序 |
| 插件分配 | 统一列表拖拽排序、跨环境移动、可用插件拖入分配、启用/禁用、自动写回 patch |
| 内核管理 | 统一内核（按环境覆盖：强制/跳过/跟随全局）、模板 + 实例 + 日志 |
| DSH 环境 | base 主环境 + 并列环境（添加/删除/激活）、DSH_HOME 初始化 |
| 设置 | 主题（浅/深/跟随系统）、语言（中/英）、路径、市场、数据备份/恢复、重置 |

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（`dsh` CLI）与 Node.js ≥ 20
- 桌面应用启动时会自动拉起内置 Node API 后端（端口 4780）

## 使用

详见 [`QUICKSTART.md`](../QUICKSTART.md)、[`使用说明.md`](../使用说明.md)。

## 已知限制

- 桌面应用依赖系统已安装的 Node.js（后端以 Node 子进程方式运行）
- GNU 工具链构建要求项目路径不含空格（见迭代日志）
- 并列环境首次安装需全量下载 dsh 依赖（界面显示进度日志）
- 卸载程序不删除运行时数据目录（`%APPDATA%\dsh-launcher\data`），如需彻底清除请先「重置」或手动删除
