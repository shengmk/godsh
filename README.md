# godsh — dsh 环境配置启动器

一个面向 **DeepSeek Harness（dsh）** 的图形化环境配置启动器，整体类比 **Anaconda Navigator**。

> 当前版本：**v0.5.1** ｜ Windows 10 / 11 ｜ 桌面（Tauri 2）+ Web

| Anaconda | DSH | godsh |
| --- | --- | --- |
| Anaconda Navigator | dsh web / CLI | 本启动器 |
| conda | dsh CLI | 启动器底层调用 |
| Python | DeepSeek Harness 核心 | dsh 本体 |
| conda env | DSH Profile | 环境管理 |
| pip/conda 包 | dsh plugin / bundle | 插件分配与安装 |
| conda channel | dshmarket / awesome-dsh-plugin | 插件市场 |

## 🙏 借鉴与致谢

本项目的实现深度借鉴了以下开源项目，特此说明：

### [DSH Desktop](https://github.com/dataelement/dsh-desktop)（DeepSeek Harness Desktop）
- **官方桌面客户端**（Electron，双击即用）。godsh 的「打开环境」功能优先调用本机安装的 DSH Desktop 打开对应 Profile（通过 `DSH_DESKTOP_DEFAULT_PROFILE` 环境变量），未安装时回退系统浏览器。
- godsh 还从其 **app.asar 提取官方 bundle 依赖**（`@deepseek-ai/*`）用于环境启动自愈，并实现了 **DSH Desktop 升级检测**（asar 指纹比对 → 自动重建依赖缓存），保证 DSH Desktop 更新后 godsh 仍能正常启动环境。

### [awesome-dsh-plugin](https://github.com/hackerFish/awesome-dsh-plugin)（dshmarket 插件市场）
- 即 **dshmarket**：dsh 插件精选列表。godsh 的「插件市场」功能读取其索引（`https://awesome-dsh-plugin.com/plugins.json`），提供搜索 / 安装 / 更新 / 卸载 / 批量安装 / **按官方分类一键分配**（UI / 工具 / 主题 / 记忆等 22 类）。
- 市场索引字段（name / npm / category / description / install）由该社区项目维护，godsh 仅消费展示。

> 致谢这些项目及其维护者，让 dsh 生态更加完善。godsh 定位为 dsh 生态的**图形化管理入口**，不做重复实现。

## ✨ 核心能力

- **📦 插件仓库沙箱中枢 (Plugin Vault)**：建立就绪态插件池，取代临时 profiles 暂存；支持本地插件源码文件夹 / `.tgz` 一键导入；插件市场支持「一键暂存」；分配页秒级流转部署到任意环境；**内置伴随服务驱动自愈**（如分发 `dsh-web-search-pro` 自动补全 `@anweat/dsh-browser`，彻底杜绝缺少 browser 驱动闪退）。
- **🛡️ 4 端网络隔离与动态随机安全端口**：新增安全端口分配引擎，未显式指定端口时，启动与重启环境自动在 `3200 ~ 3999` 区间内动态随机分配未占用安全端口，彻底杜绝端口冲突踩踏；默认严格收敛绑定 `127.0.0.1` 本地回环，杜绝内网未授权访问。
- **⚡ DSH 环境极速管理与骨架屏秒开**：自动注入 `npmmirror` 国内镜像加速与原生包编译放行，解决 DSH 更新慢与失败；新增顶栏「🔄 刷新」缓存穿透按钮；重构常驻终端任务日志面板（支持日志复制与清空）；控制台解耦并发加载并引入微光骨架屏（Skeleton Shimmer），秒开无冒号/横线。
- **💾 KeepAlive 页面常驻与全局任务中心 (Task Center)**：轻量 KeepAlive DOM 挂载容器，切换页面数据状态 100% 保持；右下角常驻悬浮全局任务微件，后台更新与构建进度随时监控与日志回溯。
- **环境（Profile）管理**：扫描/新建/删除/启停，状态徽标、实时日志、批量启停、端口占用视图、每环境指定 dsh 版本、环境包（JSON）1:1 导出与导入克隆。
- **插件分配（拖拽全面化）**：每个环境内「已分配 + 可用插件」统一列表，**全部可拖动排序**；**可跨环境拖动**（如 plugin_bag → desktop），自动写回 `cordis.patch.yml`；启用/禁用、右键菜单。
- **统一 Web 内核**：没有 `dsh-web-app` 的 Profile 也能启动出 Web UI（bundle 注入）；内核插件层可编辑，**按环境覆盖**（强制注入 / 跳过 / 跟随全局）。
- **插件市场**：搜索、安装/更新/卸载、**批量安装队列**（进度 1/N）、热门/最新排序。
- **DSH 本体管理**：base 主环境 + 并列环境（类比 Anaconda 环境），版本检测/切换、DSH_HOME 初始化。
- **内核管理**：模板 + 实例（启停/日志/删除）。
- **设置**：主题（浅/深/跟随系统）、语言（中/英）、路径、市场源、数据备份/恢复、重置（含 dsh 全删除）。
- **工程安全**：CORS 白名单、patch 写回守护 + 自动备份、git 版本控制、36 项自动化单元测试全绿覆盖。

## 🚀 快速开始

### 方式一：桌面版（推荐）

1. 从 [Releases](https://github.com/shengmk/godsh/releases) 下载 `godsh-0.5.1-x64-setup.exe`（安装版）或 `-x64.zip`（便携版）。
2. 运行并启动：应用会自动拉起内置 Node API 后端（端口 4780）。
3. 首次使用建议点击「控制台」→「快速启动默认模板」（无 dsh 会自动安装 base + 初始化官方模板）。

### 方式二：Web 版 / 源码运行

```powershell
git clone https://github.com/shengmk/godsh.git
cd godsh
pnpm install          # 安装依赖
pnpm build:web        # 构建前端
pnpm serve            # 启动 API + 前端（http://127.0.0.1:4780）
```

## 📖 文档

| 文档 | 说明 |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | 快速开始（安装 / 首次启动 / 三步上手） |
| [release/RELEASE_NOTES.md](release/RELEASE_NOTES.md) | 版本发布说明（v0.5.1 详述） |
| [docs/方案/更新方案2.md](docs/方案/更新方案2.md) | 仓库沙箱中枢、4 端隔离与自动化编程插件详细架构 RFC |
| [docs/方案/更新版本方案.md](docs/方案/更新版本方案.md) | DSH 环境更新、日志常驻与控制台性能优化落地方案 |

## 🏗 技术栈与结构

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js ≥ 20 · TypeScript ESM · 纯 `node:http` · esbuild 单文件（`server.mjs`） |
| 前端 | Vite 5 · React 18 · TS · 玻璃拟态 CSS（浅色 + 深色）· `React.lazy` 按页分包 |
| 桌面 | Tauri 2（Rust，GNU/MinGW 工具链）+ WebView2 · 自包含（后端 + 模板打进资源） |
| 安装 | NSIS 安装器（exe 旁放 WebView2Loader.dll）+ 便携 ZIP |
| 测试 | `node:test` 单元测试 + PowerShell 冒烟回归（`pnpm test` / `pnpm test:smoke`） |

```text
godsh/
├─ apps/
│  ├─ launcher/
│  └─ shell-web/
├─ packages/
│  ├─ core/
│  ├─ profile-manager/
│  ├─ plugin-registry/
│  ├─ allocation/
│  ├─ kernel-manager/
│  ├─ marketplace/
│  ├─ dsh-env/
│  └─ security/
├─ scripts/
└─ release/
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
pwsh -File scripts/bump-version.ps1 -Version 0.3.2

# 2) 打包发布版（tauri build 内嵌前端 + NSIS 安装器 + ZIP + 校验和）
pwsh -File scripts/make-release.ps1 -Version 0.3.2
```

> GNU 工具链限制：构建要求项目路径不含空格。

## 📄 License

[MIT](LICENSE)
