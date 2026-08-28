# dsh Launcher — dsh 环境配置启动器

一个面向 **DeepSeek Harness（dsh）** 的图形化环境配置启动器，整体类比 **Anaconda Navigator**。

> 当前版本：**v0.2.4** ｜ Windows 10 / 11 ｜ 桌面（Tauri 2）+ Web
>
> ⚠️ 推送到 GitHub 前，请把本文档中所有 `YOUR_NAME` 替换为你的 GitHub 用户名。

| Anaconda | DSH | dsh Launcher |
| --- | --- | --- |
| Anaconda Navigator | dsh web / CLI | 本启动器 |
| conda | dsh CLI | 启动器底层调用 |
| Python | DeepSeek Harness 核心 | dsh 本体 |
| conda env | DSH Profile | 环境管理 |
| pip/conda 包 | dsh plugin / bundle | 插件分配与安装 |
| conda channel | dshmarket / awesome-dsh-plugin | 插件市场 |

## ✨ 核心能力

- **环境（Profile）管理**：扫描/新建/删除/启停，状态徽标、实时日志、批量启停、端口占用视图、每环境指定 dsh 版本。
- **插件分配（拖拽全面化）**：每个环境内「已分配 + 可用插件」统一列表，**全部可拖动排序**；**可跨环境拖动**（如 plugin_bag → desktop），自动写回 `cordis.patch.yml`；启用/禁用、右键菜单。
- **统一 Web 内核**：没有 `dsh-web-app` 的 Profile 也能启动出 Web UI（bundle 注入）；内核插件层可编辑，**按环境覆盖**（强制注入 / 跳过 / 跟随全局）。
- **插件市场**：搜索、安装/更新/卸载、**批量安装队列**（进度 1/N）、热门/最新排序。
- **DSH 本体管理**：base 主环境 + 并列环境（类比 Anaconda 环境），版本检测/切换、DSH_HOME 初始化。
- **内核管理**：模板 + 实例（启停/日志/删除）。
- **设置**：主题（浅/深/跟随系统）、语言（中/英）、路径、市场源、数据备份/恢复、重置（含 dsh 全删除）。
- **工程安全**：CORS 白名单、patch 写回守护 + 自动备份、git 版本控制、单元测试 + 冒烟回归。

## 🚀 快速开始

### 方式一：桌面版（推荐）

1. 从 [Releases](https://github.com/YOUR_NAME/dsh-launcher/releases) 下载 `dsh-launcher-0.2.4-x64-setup.exe`（安装版）或 `-x64.zip`（便携版）。2. 运行并启动：应用会自动拉起内置 Node API 后端（端口 4780）。
3. 首次使用建议点击「控制台」→「快速启动默认模板」（无 dsh 会自动安装 base + 初始化官方模板）。

### 方式二：Web 版 / 源码运行

```powershell
git clone https://github.com/YOUR_NAME/dsh-launcher.git
cd dsh-launcher
pnpm install          # 安装依赖
pnpm build:web        # 构建前端
pnpm serve            # 启动 API + 前端（http://127.0.0.1:4780）
```

## 📖 文档

| 文档 | 说明 |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | 快速开始（安装 / 首次启动 / 三步上手） |
| [为下一个AI编程对话的资料和输入.md](为下一个AI编程对话的资料和输入.md) | **AI 交接文档**（项目全貌 / 技术约束 / 下一步方向） |
| [使用说明.md](使用说明.md) | 完整使用手册（功能 / CLI / API / 配置 / 故障排查） |
| [release/RELEASE_NOTES.md](release/RELEASE_NOTES.md) | 版本发布说明 |
| [项目文件总结.md](项目文件总结.md) | 项目文件全貌（目录 / 职责 / 架构） |
| [docs/iteration-log.md](docs/iteration-log.md) | 迭代日志（每轮改动） |
| [docs/dsh-study.md](docs/dsh-study.md) | DSH 框架学习笔记 |
| [docs/workflow.md](docs/workflow.md) | 具体工作流程 |
| [docs/folder-config.md](docs/folder-config.md) | 文件夹配置说明 |
| [优化方案大纲.md](优化方案大纲.md) | 优化方案（统一内核 / 可视化分配等） |
| [改进点（功能与界面）.md](改进点（功能与界面）.md) | 可勾选改进清单 |
| [验收清单-0.2.2.md](验收清单-0.2.2.md) | 验收清单示例 |
| [PROMPT.md](PROMPT.md) | 常驻 AI 开发提示词 |

## 🏗 技术栈与结构

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js ≥ 20 · TypeScript ESM · 纯 `node:http` · esbuild 单文件（`server.mjs`） |
| 前端 | Vite 5 · React 18 · TS · 玻璃拟态 CSS（浅色 + 深色）· `React.lazy` 按页分包 |
| 桌面 | Tauri 2（Rust，GNU/MinGW 工具链）+ WebView2 · 自包含（后端 + 模板打进资源） |
| 安装 | NSIS 安装器（exe 旁放 WebView2Loader.dll）+ 便携 ZIP |
| 测试 | `node:test` 单元测试 + PowerShell 冒烟回归（`pnpm test` / `pnpm test:smoke`） |

```text
dsh-launcher/
├─ apps/
│  ├─ launcher/           # 主应用（CLI + HTTP API + Tauri 桌面壳）
│  └─ shell-web/          # Web 管理界面（7 页，玻璃拟态）
├─ packages/
│  ├─ core/               # 环境检测、进程管理、配置存储、路径
│  ├─ profile-manager/    # Profile 扫描 / 创建 / 删除 / cordis.patch.yml
│  ├─ plugin-registry/    # bundle / client 插件识别
│  ├─ allocation/         # 插件分配（启用/禁用/顺序/拖拽写回）
│  ├─ kernel-manager/     # 内核模板 / 实例 / 统一内核
│  ├─ marketplace/        # `dsh plugin` 封装 + 市场索引
│  ├─ dsh-env/            # DSH 本体环境（base / 并列 / 外部）
│  └─ security/           # 来源校验、构建授权
├─ scripts/               # 构建 / 打包 / 版本升级 / 冒烟测试
├─ docs/                  # 设计文档 + 迭代日志
└─ release/               # 发布产物（安装器 / ZIP / 校验和 / Release Notes）
```

## 🛠 开发命令

```powershell
pnpm install          # 安装依赖
pnpm typecheck        # TypeScript 类型检查
pnpm test             # 单元测试（patch / allocation / unified-kernel）
pnpm test:smoke       # 隔离环境冒烟回归（6 组）
pnpm build:server     # 打包后端单文件 dist/server.mjs
pnpm build:web        # 构建前端 dist
pnpm serve            # 启动 API + 托管前端（http://127.0.0.1:4780）
pnpm launcher help    # CLI 命令
```

### 发布打包

```powershell
# 1) 升级版本号（自动同步全部 package.json / Cargo.toml / tauri.conf / config）
pwsh -File scripts/bump-version.ps1 -Version 0.2.5

# 2) 打包发布版（tauri build 内嵌前端 + NSIS 安装器 + ZIP + 校验和）
pwsh -File scripts/make-release.ps1 -Version 0.2.5
```

> GNU 工具链限制：构建要求项目路径不含空格（见 `docs/iteration-log.md`）。

## 📝 迭代记录

项目通过 `docs/iteration-log.md` 持续记录每一轮迭代（v0.1.0 → v0.2.4），包括关键机制修正（`dsh web` 别名、统一内核 bundle 注入、Windows shim/pid 陷阱、CORS 白名单、拖拽引擎选型等）。

## 📄 License

[MIT](LICENSE)
