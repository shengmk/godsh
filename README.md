# dsh 环境配置启动器（dsh Launcher）

一个面向 **DeepSeek Harness（dsh）** 的环境配置启动器，整体类比 **Anaconda Navigator**：

| Anaconda | DSH | dsh Launcher |
| --- | --- | --- |
| Anaconda Navigator | dsh web / CLI | 本启动器 |
| conda | dsh CLI | 启动器底层调用 |
| Python | DeepSeek Harness 核心 | dsh 本体 |
| conda env | DSH Profile | 环境管理 |
| pip/conda 包 | dsh plugin / bundle | 插件分配与安装 |
| conda channel | dshmarket / awesome-dsh-plugin | 插件市场 |

## 核心能力

- **插件分配管理**：把插件分配给不同 Profile / 工作区，并控制启停、顺序、配置。
- **同一个 Web 内核**：所有 client 插件统一加载到 DSH 的 `dsh-client-web` 内核中，不重复启动浏览器内核。
- **内核管理 / 新建**：管理 dsh 服务实例、Node/Python 运行内核、Web 内核模板，可新建、启动、停止、删除。
- **插件下载**：接入 dshmarket / awesome-dsh-plugin，一键下载、安装、更新、卸载。

## 快速了解

| 文档 | 说明 |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | 快速开始（安装 / 首次启动 / 三步上手） |
| [使用说明.md](使用说明.md) | 完整使用手册（功能 / CLI / API / 配置 / 故障排查） |
| [项目文件总结.md](项目文件总结.md) | 项目文件全貌（目录 / 职责 / 架构） |
| [优化方案大纲.md](优化方案大纲.md) | 下一迭代优化方案（统一内核 / 可视化分配 / 设置页等） |
| [改进点（功能与界面）.md](改进点（功能与界面）.md) | 可勾选的改进清单 |
| [release/](release/) | 发布产物（安装器 + 便携版 + 校验和 + Release Notes） |
| [PROMPT.md](PROMPT.md) | 常驻 AI 开发提示词，每次迭代先读它 |
| [docs/dsh-study.md](docs/dsh-study.md) | DSH 框架学习笔记 |
| [docs/workflow.md](docs/workflow.md) | 具体工作流程，适合作为实现 / 提示词参考 |
| [docs/folder-config.md](docs/folder-config.md) | 文件夹配置说明，适合作为 Agent 的上下文提示词 |
| [docs/gui-design.md](docs/gui-design.md) | GUI 风格设计与问卷 |
| [docs/iteration-log.md](docs/iteration-log.md) | 迭代日志，记录每一轮改动 |

## 顶层结构

```text
dsh-launcher/
├─ apps/
│  ├─ launcher/           # 主启动器应用（类似 Anaconda Navigator）
│  └─ shell-web/          # 可选：Launcher 自身的 Web 管理界面
├─ packages/
│  ├─ core/               # 核心领域逻辑
│  ├─ profile-manager/    # Profile（环境）管理
│  ├─ plugin-registry/    # 插件注册与状态
│  ├─ allocation/         # 插件分配管理
│  ├─ kernel-manager/     # 内核管理
│  ├─ marketplace/        # 插件下载 / 市场
│  └─ security/           # 校验、签名、权限
├─ profiles/              # 被管理的 dsh profiles（类似 conda envs）
├─ plugins/               # 本地插件 / bundle 源码
├─ kernels/               # 内核模板与实例配置
├─ data/                  # 运行时数据
├─ docs/                  # 设计文档
└─ scripts/               # 构建 / 安装脚本
```

## 本地运行（开发）

已落地为 pnpm workspace monorepo（TypeScript + ESM，`tsx` 直跑，无需预构建）。

```powershell
cd dsh-launcher
pnpm install          # 安装依赖
pnpm typecheck        # TypeScript 类型检查
pnpm launcher help    # 查看命令

pnpm launcher detect                # 检测 node/pnpm/dsh 与 DSH_HOME
pnpm launcher profiles              # 扫描 $DSH_HOME/profiles
pnpm launcher plugin ls --profile web   # 列出某 Profile 已装插件
pnpm launcher market                # 拉取插件市场索引
pnpm launcher kernels               # 内核模板与实例
```

### Web 管理界面（玻璃拟态）

```powershell
pnpm build:web          # 构建前端到 apps/shell-web/dist
pnpm serve              # 启动 API + 托管前端（默认 http://127.0.0.1:4780）

# 开发模式（前端热更新，/api 代理到 4780）：
#   终端 1: pnpm serve
#   终端 2: pnpm dev:web   → http://localhost:5173
```

界面包含四个页：**环境**（启动/停止/日志/打开）、**插件市场**（搜索/安装到 Profile）、**插件分配**（新增/启停/移除/写回 patch）、**内核管理**（模板 + 实例）。

### 桌面应用（Tauri 2）

Tauri 桌面壳位于 `apps/launcher/src-tauri/`（复用 `apps/shell-web` 前端），启动时自动拉起 Node API 后端（端口 4780）。**已自包含**：后端 `server.mjs` + 内核模板打进资源，运行时数据迁到 `%APPDATA%\dsh-launcher\data`，无需任何环境变量。

```powershell
# 首次需安装 Rust 工具链（本机无 MSVC，用 GNU 工具链 + MinGW）
pwsh -File scripts/build-tauri.ps1     # 打包后端 + 构建前端 + 编译 debug .exe

# 直接运行（自包含，无需环境变量）：
& "$env:USERPROFILE\dshlauncher\target\debug\dsh-launcher.exe"

# 打包发布版安装器（NSIS）：
#   1. 先把无空格构建目录里的 tauri.conf.json 的 beforeBuildCommand 置空
#   2. node <project>/node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --ci --no-sign
#   产物: ...\target\release\bundle\nsis\dsh Launcher_0.1.0_x64-setup.exe
```

> 注意（GNU 工具链限制）：项目路径不能含空格；`crate-type` 已设为 `rlib`（见 `docs/iteration-log.md`）。

包结构（`@dsh-launcher/*`）：

| 包 | 职责 |
| --- | --- |
| `core` | 环境检测、进程管理、配置存储、事件总线 |
| `profile-manager` | Profile 扫描 / 创建 / 删除 / patch |
| `plugin-registry` | bundle / client 插件识别 |
| `marketplace` | `dsh plugin` 封装 + 市场索引 |
| `kernel-manager` | 内核模板与实例 |
| `allocation` | 插件分配（启用/禁用/顺序，落地 cordis.patch.yml） |
| `security` | 来源校验、构建授权 |
| `apps/shell-web` | Vite + React + TS 前端 |

> 进度与设计依据见 `docs/iteration-log.md`。
