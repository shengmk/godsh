# dsh Launcher 迭代日志

> 本文件记录 dsh Launcher 的每一轮迭代，便于持续完善。
> 新需求/新改动都要在这里追加记录。

## 迭代记录格式

```text
## [日期] 迭代标题

### 目标
- ...

### 改动
- ...

### 结果 / 状态
- ...

### 下一步
- ...
```

---

## [2026-08-20] 初始化 dsh Launcher 项目

### 目标
- 建立 dsh 环境配置启动器的项目骨架。
- 学习 DSH 真实框架，并整理成文档。

### 改动
- 创建 `dsh-launcher/` 目录骨架。
- 新增：
  - `README.md`
  - `docs/workflow.md`
  - `docs/folder-config.md`
- 学习本地 DSH 源码、`.dsh` 配置、dshmarket 插件。
- 新增 `docs/dsh-study.md`，记录 DSH 框架、插件框架、Web 内核。
- 将文档升级为“Anaconda 类比 + 真实 DSH 机制”。
- 新增 `PROMPT.md` 常驻提示词。
- 新增 `docs/iteration-log.md` 迭代日志。
- 新增 `profiles/web/` 示例 Profile。
- 将 `plugins/hello-world` 改为真实 DSH Bundle 格式。

### 结果 / 状态
- 项目目前是“文档 + 骨架”阶段，还没有可运行的 Launcher 代码。
- 已确定核心方向：
  - Launcher = Anaconda Navigator
  - dsh = Python
  - Profile = conda env
  - Plugin/Bundle = pip/conda 包
  - dshmarket = 软件源

### 下一步
- 开始迭代 1：环境检测 + Profile 扫描器。
- 开始迭代 2：dsh web 进程管理。


---

## [2026-08-20] 确定 GUI 风格

### 目标
- 为 Launcher UI 确定视觉方向和交互风格。
- 为后续 UI 实现提供设计依据。

### 改动
- 新增 `docs/gui-design.md`，包含风格候选和问卷。
- 在 `PROMPT.md` 中新增 “6.5 GUI 优化部分”。
- 根据用户反馈确定 GUI 风格：
  - 蓝色渐变 + 玻璃拟态 + 简约
  - 混合布局（仪表盘 + 左侧导航 + 详情页）
  - 浅色主题
  - 舒适型信息密度
  - 全部核心交互
  - Windows 11 / 10 + Web
- 技术栈建议：Tauri 2 + React + TypeScript + Vite。

### 结果 / 状态
- GUI 风格已确认，作为后续 UI 实现基准。
- 技术栈方向已确定，等待用户最终确认后开始搭建 UI 工程。

### 下一步
- 开始搭建 `apps/shell-web` 前端工程（Vite + React + TS）。
- 设计首页仪表盘、环境卡片、插件市场、分配面板、内核管理页。
- 实现玻璃拟态设计系统（颜色、圆角、阴影、模糊）。

---

## [2026-08-20] 迭代 1–3：可运行的后端基础（monorepo + CLI）

### 目标
- 按 `PROMPT.md` 建议顺序，落地迭代 1（环境检测 + Profile 扫描）、迭代 2（dsh web 进程管理）、迭代 3（插件市场封装）。
- 建立可运行的 TypeScript monorepo 与 CLI，作为后续 UI 的后端。

### 改动
- 建立 pnpm workspace monorepo：根 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`tsconfig.json`、`.gitignore`、`scripts/`（dev/build/pack-plugin）。
- 新增 7 个包（均 `@dsh-launcher/*`，ESM + TS，tsx 直跑）：
  - `core`：`env-detect`（node/pnpm/dsh + DSH_HOME 检测）、`run`（Windows cmd shim 兼容 + 参数转义）、`config-store`、`events`（类型安全事件总线）、`process-manager`（dsh web 启动/停止/端口就绪/pid 文件）、`paths`。
  - `profile-manager`：`scanner`（扫描 `$DSH_HOME/profiles` 的 bundles/依赖/patch）、`patch`（轻量 cordis.patch.yml 解析/序列化）、`profile-editor`（创建/删除/禁用插件）。
  - `plugin-registry`：`bundle`（识别 bundle / client / both 插件）。
  - `marketplace`：`installer`（封装 `dsh plugin add/remove/update/ls`）、`dshmarket-client`（拉取 awesome-dsh-plugin 索引）。
  - `kernel-manager`：`kernel-template` + `kernel-process`（内核模板与实例，持久化 data/kernels.json）。
  - `allocation`：`allocation-manager`（插件分配、启用/禁用/顺序，落为 cordis.patch.yml）。
  - `security`：`source-policy`（registry/local 默认允许，git 需白名单）、`build-permission`（pnpm allowBuilds 管理）。
- 新增 `apps/launcher` CLI，编排全部包：`detect / profiles / profile / plugins / market / plugin / start / stop / status / kernels / kernel / allocate / allocations / help`。
- 实测对接真实 DSH（v0.1.1-rc.1）：`detect`、`profiles`（10 个真实 Profile）、`plugins`、`plugin ls --profile web`、`market`、`kernels`、`status` 均正常。

### 结果 / 状态
- `pnpm install` / `pnpm typecheck` / `pnpm launcher <cmd>` 全部可运行。
- 后端能力覆盖：环境检测、Profile 扫描、dsh web 进程管理、插件安装封装、市场拉取、内核管理、分配管理、来源校验。
- 冒烟测试（临时目录）验证了 create/remove Profile、禁用 patch 往返、分配序列化，全部通过。

### 下一步
- 迭代 4：分配管理落地（`cordis.patch.yml` 写入 + 与 Profile 扫描联动）。
- 迭代 5：内核实例的启停/日志/端口状态可视化。
- 迭代 6：搭建 `apps/shell-web` 前端（Vite + React + TS），对接上述 CLI/后端，实现玻璃拟态 UI。

---

## [2026-08-20] 迭代 4–6：分配落地 + HTTP API + Web UI（玻璃拟态）

### 目标
- 把插件分配真正写回 Profile 的 `cordis.patch.yml`（迭代 4）。
- 把启动器从「CLI」升级为「可被 UI 调用的 HTTP 服务」（迭代 5 可视化基础）。
- 搭建 `apps/shell-web` 前端，实现已确认的玻璃拟态 UI（迭代 6）。

### 改动
- `allocation`：新增 `applyProfile(profilesDir, profile)`，把分配关系落地为真实 `cordis.patch.yml`，只重写本管理器管理的插件条目、保留其它用户自定义条目。
- `core`：拆分 `spawnWebProfile`（立即返回）/ `startWeb`（等待就绪），新增 `readLogTail`。
- `apps/launcher`：
  - 抽取 `context.ts` 共享上下文，CLI 与 API 服务复用同一套 manager。
  - CLI 新增 `apply / sync / unallocate / serve` 命令。
  - 新增 `server.ts`：node:http 编写的 JSON API（`/api/health|profiles|plugins|market|allocations|kernels`，含 Profile 启停/日志、插件安装、分配 CRUD+apply、内核 CRUD），并回退到静态资源。
- 新增 `apps/shell-web`（Vite + React 18 + TS）：
  - 玻璃拟态设计系统（蓝色渐变 `#2563EB→#38BDF8`、半透明白卡 + `backdrop-filter`、大圆角、柔和阴影）。
  - 左侧导航 + 四页：环境（启动/停止/日志/打开）、插件市场（搜索/安装到 Profile）、插件分配（新增/启停/移除/应用）、内核管理（模板+实例）。
  - `api.ts` 封装全部 REST 接口；Vite dev 代理 `/api` → 4780，生产由 API 服务同源托管 dist。

### 结果 / 状态
- `pnpm typecheck`（后端）与 `pnpm build:web`（前端 tsc + vite build）均通过。
- 实测：`serve --port 4780` 后，`/api/health`、`/api/profiles`、`/api/kernels` 正常返回；内核/分配的 POST+DELETE 往返通过且数据文件恢复为空；`/` 正确返回构建后的前端。

### 下一步
- 前端细节：拖拽排序、实时日志轮询、启动进度、右键菜单、托盘/通知、快捷键（GUI 问卷中的“全部交互”）。
- 桌面壳：Tauri 2 包装（前端已可复用为 Web）。
- 分配顺序持久化到 `data/allocations.json` 并在 UI 中拖拽调整。

---

## [2026-08-20] 前端增强：实时日志轮询 + 分配拖拽排序

### 目标
- 落地 GUI 问卷中的「实时日志滚动」与「插件拖拽排序」。

### 改动
- `server.ts`：新增 `POST /api/allocations/reorder`（`{ profile, orderedIds }`），复用 `AllocationManager.reorder`。
- `shell-web/api.ts`：新增 `reorderAllocations`。
- `shell-web/pages/ProfilesPage.tsx`：打开日志后每 2s 轮询 `/api/profiles/:name/log`，自动滚动到底部，可暂停/继续。
- `shell-web/pages/AllocationsPage.tsx`：分配卡片支持原生 HTML5 拖拽排序（乐观更新 + 调接口回写顺序），带 ⠿ 抓手与拖拽态样式。

### 结果 / 状态
- `pnpm typecheck`、`pnpm build:web` 通过。
- 实测 reorder：创建 a/b/c 三条分配后反转顺序，`/api/allocations` 返回顺序由 `a,b,c` 变为 `c,b,a`，数据文件清理恢复为空。

### 下一步
- 托盘/通知、快捷键、右键菜单；启动进度条；Tauri 2 桌面壳。

---

## [2026-08-20] 启动进度 + 状态自动刷新；实测真实启停并修正 dsh 命令

### 目标
- 前端「启动中」进度与状态自动刷新。
- 用真实 DSH 环境实际验证「启动/停止 Profile」核心链路。

### 关键发现（真实 DSH 机制修正）
- `dsh web` 是 `--profile web` 的**硬编码别名**，**不接受** `--profile`。
  - `dsh --profile <name> web` 会报 `web takes none of parent --profile ...`。
- 启动任意 Profile 的 Web UI 正确命令：`dsh --profile <name> --port <port> --no-open`（无 `web` 字样）。
- 据此修正 `packages/core/process-manager.ts` 的生成命令，并同步修正 `PROMPT.md`、`docs/workflow.md`、`docs/folder-config.md`，在 `docs/dsh-study.md` 记录该机制。

### 改动
- `core/process-manager.ts`：修正启动命令；日志改为每次启动截断（`flags: 'w'`），避免历史错误混入。
- `server.ts`：新增 `starting` 状态（后台 `waitForPort` 探测端口就绪后翻转为 `running`）；`profileView`/`/status` 统一以「端口就绪」为运行标准。
- `shell-web`：`ProfileView` 增加 `starting`；环境页每 3s 自动刷新状态，「启动中…」徽标 + 脉冲动画，启动按钮在 starting 时禁用。

### 结果 / 状态（实测）
- 手动 `dsh --profile ui-market --port 3092 --no-open` → 端口 3092 返回 HTTP 200。
- API 启动 `ui-market` → 5.2s 端口就绪（running=true）→ HTTP 200 → 停止后端口关闭、pid 文件删除。
- 内核实例生命周期：create → start（HTTP 200）→ stop → delete，全部通过。
- 日志截断生效：重启后日志仅含本次输出，无历史 `takes none of parent` 残留。
- `pnpm typecheck`、`pnpm build:web` 通过。

### 下一步
- 托盘/通知、快捷键、右键菜单；启动进度条细化；Tauri 2 桌面壳。

---

## [2026-08-20] 快捷键 + 右键菜单（Web 交互）

### 目标
- 落地 GUI 问卷「核心交互」中的快捷键与右键菜单。

### 改动
- `components.tsx`：新增通用 `ContextMenu` 右键菜单组件（点击任意处 / Esc / 再次右键关闭，自动防越界）。
- `App.tsx`：`Ctrl/Alt/Cmd + 1..4` 切换页面（输入框内不拦截），侧栏显示快捷键角标与脚注。
- `ProfilesPage.tsx`：Profile 卡片右键菜单（启动/停止、打开 Web UI、查看日志、复制端口/地址）。
- `AllocationsPage.tsx`：分配卡片右键菜单（启用/禁用、上移、下移、移除），并补充上移/下移的 reorder 逻辑。
- `styles.css`：右键菜单、快捷键角标、侧栏脚注样式。

### 结果 / 状态
- `pnpm build:web`（tsc + vite）通过；产物 bundle 确认包含 `context-menu` / 快捷键 / `clipboard` 逻辑。
- 检测到本机**未安装 Rust/cargo**，Tauri 2 桌面壳需先安装 Rust 工具链后才能推进。

### 下一步
- 安装 Rust 工具链后搭建 Tauri 2 桌面壳（托盘/通知由 Tauri 侧提供）。
- 前端补充：启动进度条细化、市场安装进度、主题切换。

---

## [2026-08-20] Tauri 2 桌面壳（Rust 工具链 + 脚手架 + 构建）

### 目标
- 为 Launcher 搭建 Tauri 2 桌面壳（托盘/通知由桌面侧提供）。

### 改动
- 安装 Rust 工具链（rustup，用户级，minimal + stable）：rustc/cargo 1.98.0。
- 因本机**无 MSVC 链接器**（未装 VS Build Tools），改用已装 MinGW 的 **GNU 工具链**（`x86_64-pc-windows-gnu`），并配置清华镜像（rustup dist + cargo sparse index）。
- 安装 `@tauri-apps/cli`，用 `tauri init --ci` 生成 `apps/launcher/src-tauri/`（含默认图标、Cargo.toml、tauri.conf.json、main.rs/lib.rs、capabilities）。
- 修正 tauri.conf.json 的 `identifier`/`productName`/窗口尺寸，Cargo 包名改为 `dsh-launcher`。
- 前端 `api.ts` 的 API 基址改为可用 `VITE_API_BASE` 覆盖（Tauri 模式可指向 `http://127.0.0.1:4780/api`）。

### 关键发现 / 坑
- **路径含空格 + GNU 工具链**：`tauri-winres`（嵌入图标/版本信息）调用 MinGW `windres` 时不能处理带空格的路径（项目在 `...\dsh projects\dsh launcher\...`），导致构建失败。
  - 解法：把 `src-tauri/` + `apps/shell-web/dist` 复制到**无空格路径**（`%USERPROFILE%\dshlauncher\`）构建，`CARGO_TARGET_DIR` 也设为无空格路径。
- **旧 MinGW binutils 太旧**：本机 `D:\mingw64` 是 GCC 8.1.0，链接报 `export ordinal too large`。
  - 解法：从清华镜像装 MSYS2 + `mingw-w64-x86_64-gcc`（binutils 2.47）。
- **GNU 下 cdylib 导出表溢出**：Tauri 默认 `crate-type = ["staticlib","cdylib","rlib"]`，GNU 链接 cdylib 时导出表 `export ordinal too large`（binutils 2.47 仍复现）。
  - 解法：桌面端改用 `crate-type = ["rlib"]`（cdylib/staticlib 仅移动端需要）。
- 本机已具备 WebView2 运行时（Windows 11 自带）。

### 结果 / 状态（实测）
- Rust/GNU 工具链可链接；Tauri `dsh-launcher.exe`（debug，206MB）**构建成功**。
- 运行 `.exe`：进程存活、内存 54.8MB、**窗口标题 "dsh Launcher"**，桌面窗口正常打开。
- 新增 `scripts/build-tauri.ps1` 固化「无空格目录 + MinGW + cargo build」构建流程。
- 已同步 `crate-type = ["rlib"]` 修正到 `apps/launcher/src-tauri/Cargo.toml`。

### 下一步
- 让桌面应用真正可用：Tauri 侧启动 Node API（`serve`），前端用 `VITE_API_BASE` 指向 `http://127.0.0.1:4780/api`。
- 托盘/通知；发布版（`cargo build --release` + `tauri build` 打包安装器）。

---

## [2026-08-20] Tauri 端到端打通：后端打包 + Tauri 启动后端 + 前端指向

### 目标
- 让桌面应用真正可用：Tauri 启动时拉起 Node API，前端指向它，实现环境/插件/内核的端到端操作。

### 改动
- `packages/core/paths.ts`：`MONOREPO_ROOT` 支持 `DSH_LAUNCHER_ROOT` 环境变量覆盖（打包后 `import.meta.url` 指向产物而非源码）。
- 新增 `build:server`：用 esbuild 把后端打包成单文件 `apps/launcher/dist/server.mjs`（54.5KB，仅需 node 运行）。
- `shell-web`：新增 `.env.tauri`（`VITE_API_BASE=http://127.0.0.1:4780/api`）与 `build:tauri`（`vite build --mode tauri`）。
- `src-tauri/src/lib.rs`：`setup` 中 `spawn node <server.mjs> serve --port 4780`（读 `DSH_LAUNCHER_SERVER`/`DSH_LAUNCHER_ROOT`），`RunEvent::Exit` 时杀后端进程。
- `build-tauri.ps1`：补充「打包后端 + 构建前端(tauuri)」两步。

### 结果 / 状态（实测）
- 打包版后端独立运行正常（`node dist/server.mjs profiles` → 10 个 Profile）。
- 运行 `.exe`（带 `DSH_LAUNCHER_SERVER`/`DSH_LAUNCHER_ROOT`）：窗口「dsh Launcher」打开，后端 4780 响应 `/api/health`（dsh 0.1.1-rc.1）、`/api/profiles`（10 个 Profile）。
- 桌面端到端链路（Tauri 窗口 → Node API → DSH）打通。

### 下一步
- 自包含化：把 `server.mjs` 打进 Tauri 资源（`bundle.resources`），运行时用资源目录解析路径，去掉环境变量依赖。
- 运行时数据目录迁移到用户级（`%APPDATA%\dsh-launcher\`）。
- 托盘/通知；`tauri build` 打包安装器（NSIS/MSI）。

---

## [2026-08-20] Tauri 自包含化 + 打包安装器

### 目标
- 桌面应用自包含（后端 + 内核模板打进资源，数据迁到用户级，无需环境变量）。
- `tauri build` 打包出可分发安装器。

### 改动
- `paths.ts`：`DATA_DIR` 支持 `DSH_LAUNCHER_DATA_DIR` 覆盖；`KERNEL_TEMPLATES_DIR` 支持 `DSH_LAUNCHER_TEMPLATES_DIR` 覆盖。
- `src-tauri/resources/`：新增运行时资源目录（`server.mjs` + `templates/`），`bundle.resources = ["resources"]`。
- `src-tauri/lib.rs`：`resolve_resource` 从 `resource_dir()/resources/` 解析 server.mjs/templates，并设置 `DSH_LAUNCHER_DATA_DIR`（默认 `%APPDATA%\dsh-launcher\data`）与 `DSH_LAUNCHER_TEMPLATES_DIR`；`RunEvent::Exit` 杀后端。
- `scripts/build-tauri.ps1`：填充 resources 目录（server.mjs + templates）。
- 踩坑：`resource_dir()` 返回 `\\?\C:\...`（verbatim）前缀，node 无法解析，加 `clean_path` 去掉前缀；资源 `../dist` 会落在 `_up_/`，改为 `resources/` 子目录避免歧义。

### 结果 / 状态（实测）
- 无环境变量运行 `.exe`：窗口 + 后端 4780 均正常；`/api/kernels` 返回 1 个模板（资源）；创建内核实例写入 `%APPDATA%\dsh-launcher\data\kernels.json`（数据目录迁移成功）。
- `tauri build`（release + NSIS）进行中。

### 下一步
- 确认安装器产物；托盘/通知；运行时数据目录内 seed 默认 config.json。

---

## [2026-08-26] 发布打包 + 文档（为 GitHub 发布准备）

### 目标
- 整理发布产物、统一版本号，编写快速开始与使用说明文档。

### 改动
- 新增 `release/`：`dsh-launcher-0.1.0-x64-setup.exe`（NSIS 安装器）、`dsh-launcher-0.1.0-x64.exe`（免安装单文件）、`SHA256SUMS.txt`、`RELEASE_NOTES.md`。
- 新增 `scripts/bump-version.ps1`：一键统一升级 package.json / Cargo.toml / tauri.conf.json / config.json 的版本号。
- 新增 `QUICKSTART.md`（快速开始）、`使用说明.md`（完整使用手册：功能/CLI/API/配置/桌面构建/故障排查/开发）。
- 新增 `LICENSE`（MIT，可自行修改版权人）、`CHANGELOG.md`。
- 更新 `.gitignore`（忽略构建产物、`release/*.exe` 等，二进制作为 GitHub Release 附件）；`README.md` 补充文档链接。
- 确认版本号全局一致（0.1.0）。

### 结果 / 状态
- release 产物就绪，校验和已生成；文档齐全；`git init` 待执行。

### 下一步
- `git init` + 首次提交；创建 GitHub 仓库并推送；打 tag `v0.1.0` 并上传 release 附件。

---

## [2026-08-27] 修复「找不到 WebView2Loader.dll」+ 重新打包发布

### 问题
- 用户安装/运行后报「找不到 WebView2Loader.dll，程序无法运行」。
- 根因：GNU 工具链下 `WebView2Loader.dll` 是 WebView 初始化必需的动态依赖（加载于 exe 目录）；
  Tauri 默认 NSIS 打包只把资源放进 `resources/` 子目录，未放到 exe 旁；且旧版 `release/` 裸 exe 也未附带 DLL。

### 修复
- 新增 `scripts/make-release.ps1`：受控打包（`dsh-launcher.exe` + `WebView2Loader.dll`（exe 旁）+ `resources/`）：
  - 生成便携 ZIP（`dsh-launcher-<v>-x64.zip`）。
  - 用自定义 NSIS 脚本生成安装器（`dsh-launcher-<v>-x64-setup.exe`，安装到 `%LOCALAPPDATA%\dsh-launcher`，DLL 放 exe 旁）。
  - 自动生成 SHA256SUMS.txt。
- 移除会误导用户的旧裸 `release/dsh-launcher-0.1.0-x64.exe`（缺 DLL 无法运行）。
- 还原 `main.rs`（放弃不可靠的运行时自愈复制方案；DLL 是启动期依赖，进程到不了 main）。
- 更新 `QUICKSTART.md` / `使用说明.md` / `RELEASE_NOTES.md` / `CHANGELOG.md`。

### 结果 / 状态（实测）
- 新安装器静默安装：exe 旁 DLL 存在；运行 → 窗口「dsh Launcher」+ 后端 4780 响应。
- 便携 ZIP 解压：exe 旁 DLL 存在；运行 → 窗口 + 后端均正常。
- `release/` 最终产物：`dsh-launcher-0.1.0-x64-setup.exe`（3.6MB）+ `dsh-launcher-0.1.0-x64.zip`（5.4MB）+ `SHA256SUMS.txt` + `RELEASE_NOTES.md`。

### 下一步
- 推 GitHub + 打 tag v0.1.0，上传 setup/zip 作为 Release 附件。

---

## [2026-08-27] 修复「界面 404」：必须用 tauri build 编译（内嵌前端）

### 问题
- 用户安装/运行后，桌面窗口和网页都显示 404 / 无法访问。
- 诊断：用 WebView2 远程调试（`--remote-debugging-port`）发现窗口加载的是 `http://localhost:5173`（Vite dev 地址），而非内嵌前端。

### 根因
- Tauri 的 `tauri` crate 在 `build.rs` 里：`dev = !custom-protocol`。
  - `tauri build` 会加 `--features custom-protocol` → `dev=false` → **内嵌 frontendDist**；
  - 普通 `cargo build --release` 不加 → `dev=true` → 用 `devUrl`(5173)。
- 此前为还原 main.rs 用普通 `cargo build --release` 重编过 exe，导致打包进了指向 5173 的版本 → 界面 404。

### 修复
- `scripts/make-release.ps1` 重写为完整流程：`build:server` → `build:tauri` → 同步无空格目录 → **`tauri build --no-bundle`（内嵌前端）** → 打 ZIP + 自定义 NSIS（DLL 在 exe 旁）→ 校验和。
- 修脚本细节：pnpm 的 .ps1 包装 stderr 在 `$ErrorActionPreference=Stop` 下误判；`Set-Content -Encoding UTF8` 写 BOM 导致 serde_json 解析失败 → 改用 `Continue` + 无 BOM 写入。

### 结果 / 状态（实测，CDP 读取窗口内容）
- 安装器 / ZIP 安装运行：窗口加载 `http://tauri.localhost/`（内嵌前端），**UI 完整渲染**（侧边栏四页 + 环境列表 + 后端数据 DSH 0.1.1-rc.1）。
- 后端 4780 全部接口 200。
- `release/`：`dsh-launcher-0.1.0-x64-setup.exe` + `.zip` + `SHA256SUMS.txt` + `RELEASE_NOTES.md`。

### 下一步
- 推 GitHub + 打 tag v0.1.0，上传 Release 附件。

---

## [2026-08-27] 修复「未发现任何环境」+ 插件市场中文化

### 问题
- 桌面应用（开始菜单启动）显示「未发现任何环境」。
- 插件市场描述显示英文。

### 根因
- 桌面应用从开始菜单启动时**没有 `DSH_HOME` 环境变量**（它不是持久用户变量），
  `createContext` 的 `config.dsh.home || process.env.DSH_HOME` 均为空 → profilesDir 为空 → 扫不到环境。
- 市场数据 `description` 是 `{ en, zh }` 对象，前端 `desc()` 优先取 `en`。

### 修复
- `context.ts`：DSH 根目录兜底 `~/.dsh`（`config.dsh.home || DSH_HOME || homedir()/.dsh`）。
- `MarketPage.tsx`：描述优先 `zh`；新增分类（中文映射）、★星标、↓下载量展示。

### 结果 / 状态（实测，CDP）
- 清除 DSH_HOME 后启动：环境页正常显示 10 个 Profile（`C:\Users\Shengmingkai\.dsh\profiles`）。
- 市场页全中文描述 + 分类/星标/下载量。
- `make-release.ps1` 重新打包完成。

### 下一步
- 推 GitHub + 打 tag v0.1.0，上传 Release 附件。

---

## [2026-08-27] 交付物：项目文件总结 + 优化方案大纲 + 改进点清单 + 整体打包

### 目标
- 汇总用户反馈，准备下一迭代的详细输入提示词与交付物。

### 交付
- `项目文件总结.md`：130 个文件全貌（架构 / 目录职责 / 构建运行 / 当前状态 / 限制）。
- `优化方案大纲.md`：下一迭代输入提示词（统一内核、可视化分配、dsh 版本管理、设置页、侧边栏、UI 美化、补充改进、实施顺序、风险）。
- `改进点（功能与界面）.md`：可勾选改进清单（A 功能 / B 界面 / C 工程）。
- `README.md` 补充文档链接；项目整体打包（git 源码 + release 产物）。

### 用户反馈已记录
- 每个 Profile 都应能运行统一 Web 内核；内核可修改、可加插件。
- 插件分配要可视化（Profile 展开 + 插件拖拽），不要输入 ID。
- dsh 版本管理（环境配置在 dsh 外）。
- 一体化界面 + 设置页（语言/文件位置/主题深浅）。
- 侧边栏去数字、展示页面功能说明；UI 更美观。

### 下一步
- 按《优化方案大纲.md》实施：优先插件分配可视化 → 统一内核 → 设置页 → dsh 版本 → UI 美化。

---

## [2026-08-27] P0 快修：运行状态恢复 + 分配自动写回 + 进程/配置隐患

### 目标
- 修复代码审查发现的 4 个真实隐患，为后续大迭代打底（本轮只做快修）。

### 改动
1. **运行状态恢复（server.ts + core/process-manager.ts）**
   - 新增 `pidDir/runtime.json` 持久化 profile→port 映射：启动时写入、停止/进程退出时清理。
   - API 服务重启后从 runtime.json 回读：以「端口就绪」判活（与 profileView/status 语义一致）。
   - **关键发现（Windows shim）**：`dsh` 走 `cmd.exe` shim，pid 文件记录的是 shim 的 pid；API 重启后 shim 已退出、真实 dsh（node）被孤儿化但仍监听端口 → 只靠 pid 文件判活会误判「已停止」。
   - 新增 `findPidByPort()`（netstat -ano 反查监听端口的真实 pid）；`stopWeb` 增加按端口回退终止，恢复的进程也能正常停止。
   - 恢复进程的 pid 显示为按端口反查到的真实 dsh pid。
2. **分配自动写回（server.ts + allocation）**
   - 分配增/删/改/排序后自动 `applyProfile` 写回 `cordis.patch.yml`，不再依赖手动「应用」按钮。
   - 删除分配时把对应 pluginId 一并从 patch 清理（`applyProfile(profile, removedIds)`）。
   - 无条目且原本无 patch 文件时不创建空文件，避免自动写回制造垃圾文件。
3. **kernel child 引用（kernel-process.ts）**
   - `KernelManager` 持有运行中 web 内核的 ChildProcess 引用（`children` Map），移除 `void child`，避免 GC 隐患；stop/remove 时清理。
4. **配置兜底顺序（context.ts + data/config.json）**
   - `DSH_HOME` 环境变量优先于 `config.json` 的 `dsh.home`，再兜底 `~/.dsh`；`data/config.json` 移除硬编码的开发机路径，避免分发到其它机器时误用旧路径。

### 结果 / 状态（实测，19/19 通过）
- 冒烟测试（`_smoke.ps1`，含临时隔离环境）：
  - A 组：模拟上一会话遗留进程，API 重启后恢复 running / 端口 / 真实 pid 全部正确。
  - B 组：分配→patch 写入；禁用→`disabled: true`；删除→patch 清空，全部自动写回。
  - C 组：真实 `dsh --profile web --port 39100` 启动 → 杀 API 重启 → 恢复 running → 按端口回退停止 → 端口释放。
- `pnpm typecheck`、`pnpm build:server`、`pnpm build:web` 全部通过。

### 下一步
- 按《优化方案大纲.md》推进：统一内核（--patch 注入，配置层已实测可行）→ 插件分配可视化 → 设置页 → dsh 版本管理。

---

## [2026-08-27] P0 核心①：统一内核（bundles 注入，实测 open-design 出 UI）

### 目标
- 让没有 dsh-web-app 的 Profile（open-design、experiment）也能启动出 Web UI；内核插件层可编辑。

### 关键发现（修正原方案）
- **`--patch` 注入单行 web-app 不可行**（实测 dsh 0.1.1-rc.1）：Web 表面由 `@deepseek-ai/dsh-web-app` **bundle 自带的 cordis.patch.yml** 提供（host-webserver / host-apiproxy / client-modules / 全部 ui-* client 行等几十个条目）；仅 `--patch` 插入 web-app 行会因缺少 `webServer` 服务启动失败。
- **正确机制 = bundle 注入**：把 `@deepseek-ai/dsh-web-app` 加入 Profile 的 `dsh.profile.bundles`（dsh 原生机制，与 `dsh plugin add` 维护同一列表），bundle patch 自动加载完整 Web 表面。bundle 包从 dsh 安装目录解析，**无需安装依赖**（web profile 的 bundles 含 web-app 但 dependencies 里没有它，照常启动）。

### 改动
- 新增 `packages/kernel-manager/src/unified-kernel.ts`：`UnifiedKernelManager`
  - 配置 `data/unified-kernel.json`：`{ enabled, plugins, managed }`；managed 记录每个 Profile 由本工具添加的 bundle id，保证还原时**只移除注入项、不动用户原有配置**。
  - `applyToProfile`（幂等，web-app 紧跟 dsh-base，用户插件追加尾部，无 BOM 写回）/ `revertProfile` / `applyToAll` / `revertFromAll`。
- `server.ts`：启动 Profile / 内核实例前 `ensureUnifiedKernel`；新增 `GET|PUT /api/unified-kernel`（PUT 修复：原 handleApi 未读 PUT body，已补）与 `POST /api/unified-kernel/apply|revert`（开关联动：启用自动应用、禁用自动还原）。
- `cli.ts`：`start`/`kernel start` 自动应用；新增 `unified-kernel on|off|apply|revert|add|remove|enable|disable|reorder`。
- `KernelsPage.tsx`：新增「统一内核」配置卡（启用开关、插件列表增删/排序/启停、应用到所有环境、还原按钮）。
- 附带修复：`server.ts` handleApi 的 body 读取加入 PUT 方法（此前 PUT 请求体被丢弃）。

### 结果 / 状态（实测，12/12）
- 临时 DSH_HOME + 真实 profile 副本：open-design（bundles 仅 dsh-base）启动 → bundles 自动注入 web-app → **HTTP 200 输出完整 Web UI**。
- web profile（自带 web-app）不重复注入；添加 dshmarket 后应用/禁用/还原全链路正确；用户原有 bundles 不受影响。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过。

### 下一步
- P0 核心②：插件分配可视化。

---

## [2026-08-27] P0 核心②：插件分配可视化（Profile 树 + 拖拽 + 点选）

### 目标
- 告别手填插件 ID：Profile 可展开成树，插件拖拽排序 / 拖到其它环境，从已安装点选添加。

### 改动
- `server.ts`：
  - `GET /api/allocations/available`：每个 Profile 的「可分配插件」清单（dependencies + bundles 去重，含 allocated/enabled 状态），已安装未分配的插件自动提示。
  - `POST /api/allocations/:id/move { profile }`：跨 Profile 移动分配关系，自动写回旧/新两个 Profile 的 cordis.patch.yml。
- `AllocationsPage.tsx` 重做：全部 Profile 的折叠面板（状态/分配数/可添加数徽标）→ 展开后插件卡片支持同 Profile 拖拽排序、拖到其它 Profile 面板移动、启停/上移/下移/移除/右键菜单，「从已安装添加」下拉点选（不再输入 ID）。
- `types.ts` / `api.ts`：新增 `AvailablePlugin`、`allocationsAvailable`、`moveAllocation`。

### 结果 / 状态（实测，10/10）
- available 清单正确（依赖/bundle 来源、分配状态随操作更新）；点选分配自动写回；跨 Profile 移动后旧 patch 清理、新 patch 写入。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过。

### 下一步
- P1：设置页（主题 → 语言 → 路径）、dsh 版本管理；P1/P2：侧边栏去数字 + 功能说明、仪表盘、UI 美化。

---

## [2026-08-27] P1：设置页 + dsh 版本管理 + 侧边栏优化 + 仪表盘

### 目标
- 设置页（外观/路径/市场/DSH 运行时）、dsh 多版本检测与切换、侧边栏去数字加功能说明、首页仪表盘。

### 改动
- **后端**：
  - `core/types.ts` / `config-store.ts`：`LauncherConfig.dsh` 增加 `instances / activeVersion / byProfile / dirs`；新增 `writeConfig()`。
  - `core/env-detect.ts`：新增 `findDshInstances()`——扫描 PATH（.cmd/.ps1 shim 反解 npm 包目录，无扩展名裸 dsh 文件同路径反解 + 按入口去重）、npm/pnpm 全局根、配置目录；每个实例给出可直接 `node <entry>` 的入口与版本号。
  - `core/process-manager.ts`：`WebProcessStartOptions.dshBin`——指定版本时直接 `node <entry> ...`（绕开 cmd shim）；`kernel-manager` 透传。
  - `server.ts`：`GET|PUT /api/settings`（配置读写 + 检测实例 + 生效路径展示）；启动 Profile/内核时按 `byProfile[profile] ?? activeVersion` 解析 dshBin。
  - `cli.ts`：新增 `settings` 命令；`start`/`kernel start` 打印并使用指定版本。
- **前端**：
  - 新增 `src/i18n.ts`（zh-CN/en 轻量语言包，localStorage 持久化，导航/页头/设置页接入）与 `src/theme.ts`（浅色/深色/跟随系统，`data-theme` + CSS 变量）。
  - `App.tsx`：侧边栏**去掉数字角标**、改为页面功能说明；导航扩为 6 页（仪表盘/环境/市场/分配/内核/设置），保留 Ctrl+1..6 快捷键（不显示数字）。
  - 新增 `DashboardPage.tsx`（环境/运行中/插件/内核/分配统计卡 + 快捷操作 + 5s 运行状态刷新）。
  - 新增 `SettingsPage.tsx`：外观（主题/语言）、DSH 运行时（实例列表/设为默认/额外目录）、文件位置（DSH 根目录可编辑，数据/日志/模板/插件目录只读展示，重启生效提示）、市场（启用/URL）。
  - `ProfilesPage.tsx`：每环境「dsh 版本」下拉（默认/实例，写入 byProfile）。
  - `styles.css`：surface 系列 CSS 变量 + `[data-theme='dark']` 深色主题 + 仪表盘/路径样式。

### 结果 / 状态（实测，12/12 + 回归 41/41）
- P1 冒烟：settings 读写往返（含 config.json 落盘）、检测到真实 dsh 实例（版本 0.1.1-rc.1）、**指定版本（node <entry>）真实启动并输出 Web UI**、还原清空。
- 回归：P0 快修 19/19、统一内核 12/12、分配可视化 10/10。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过。

### 下一步
- P1/P2：UI 美化（组件库/动效/骨架屏）、响应式、深色主题细节打磨；内容级 i18n（市场卡片等深水区文案）。

---

## [2026-08-27] P2-A 体验补强：启动失败诊断 + 内核日志 + 数据备份 + 顶栏搜索 + UI 打磨

### 目标
- 启动失败可诊断、内核实例可看日志、数据可备份、顶栏全局搜索、键盘/响应式/动画打磨。

### 改动
- **后端**：
  - `server.ts`：启动流程新增 `error` 状态——进程提前退出（未监听端口）立即标记 `procError`（不必等 60s 超时），超时未就绪同样标记；`profileView`/`/status` 透出 `procError`；error 状态允许重新启动。
  - 新增 `GET /api/kernels/:id/log`（复用 `dsh-<profile>-<port>.log`）。
  - 新增 `GET /api/backup`（导出 config/kernels/allocations/unified-kernel）与 `POST /api/backup/restore`（覆盖式导入）。
- **前端**：
  - `ProfilesPage`：启动阶段提示（spawn → 端口就绪检测）；启动失败显示红色诊断卡（错误信息 + 常见原因 + 查看日志）。
  - `KernelsPage`：实例「日志」按钮 + 2s 轮询日志面板。
  - `SettingsPage`：数据备份区（导出 JSON 下载 / 导入恢复）。
  - `App.tsx`：新增顶栏——全局搜索（环境可一键启动、插件/内核点击跳转）+ 当前 dsh 版本徽标。
  - `styles.css`：顶栏/搜索下拉样式、`:focus-visible` 键盘焦点、`@media (max-width:900px)` 响应式、页面入场动画、骨架屏样式（预留）。

### 结果 / 状态（实测，10/10 + 回归 53/53）
- P2 冒烟：broken profile（不存在的 bundle）启动 → 快速标记 error + procError 透出 + 日志非空；内核实例日志读取；备份导出 → 改数据 → 导入恢复（分配清空、市场 URL 还原）。
- 回归：快修 19/19、统一内核 12/12、分配 10/10、P1 12/12。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过，无残留进程。

### 下一步
- 可选 P2：批量启停、端口占用可视化、Tauri 托盘/通知（需 Rust 侧）、内容级 i18n、GitHub Actions 自动打包。

---

## [2026-08-27] v0.2.0：DSH 环境管理 + 控制台主页 + 环境/插件补齐 + 重置/卸载

### 目标（按用户确认的《大纲.md》v2）
- 环境（Profile）新建/删除、插件卸载/更新、dsh 版本显示保证准确、**DSH 总环境**（base 主环境 + 并列环境，类比 Anaconda）、无 dsh 自动安装成 base、全部清空（范围自选）、uninstall.exe 调用验证、Controller Console 主页。

### 改动
- **新增 `packages/dsh-env`（DshEnvManager）**：base（npm 全局）/ managed（`npm install --prefix` 受管目录）/ external（检测）三类 DSH 环境；添加/删除/激活/更新；`initHome()` 初始化 DSH_HOME + 官方默认 web 模板；`status()`（found/base/激活/npm 最新版）；安装流式写日志。
- **server.ts**：
  - `POST/DELETE /api/profiles`（新建/删除，运行中禁止删除）；`GET /api/profiles/:name/plugins` 增加 `installedNames`。
  - `GET /api/dsh/status`、`POST /api/dsh/install|update`（后台任务 + 进度日志；**运行中有环境时 409 拦截**——Windows 上运行中的 dsh 会锁 sharp DLL，必须先停止）、`POST /api/dsh/init-home`。
  - `GET/POST/DELETE /api/dsh-envs`、`POST /api/dsh-envs/:id/activate`。
  - `POST /api/reset { scope: 'data'|'all' }`（先停止所有运行中环境；all 额外删除全部 Profile 目录）。
  - `POST /api/app/uninstall`（定位并调用 uninstall.exe）。
- **CLI**：`dsh-envs`、`dsh-install`、`reset` 命令。
- **前端**：
  - 新增 **ControllerConsolePage（控制台主页）**：一键「快速启动默认模板」（无 dsh → 装 base → init-home → 启动默认环境）+ 状态卡 + 快捷入口。
  - 新增 **DshEnvsPage**：环境列表（base/并列/外部，版本/目录/默认徽标）、添加并列环境（名称+版本）、删除（managed）、设为默认、更新 base、环境↔Profile 分配、初始化官方模板、安装进度面板。
  - 环境页：新建环境 + 右键删除（确认）；市场页：已装状态 + 更新/卸载按钮。
  - 设置页：DSH 运行时移入 DSH 环境页；新增「dsh 全部清空（重置）」范围自选区 + 「卸载 Launcher」按钮。
  - 顶栏/控制台版本显示：**完整版本号 + 来源标注**（实际激活环境 / PATH），点击跳 DSH 环境页；控制台显示 npm 最新版（0.1.1-rc.2）。
  - 导航 7 页（控制台/环境/市场/分配/内核/DSH 环境/设置），Ctrl+1..7。

### 关键结论
- **dsh 版本显示**：查清"0.8rc" = 早先的 `0.1.0-rc.8`（npm 曾发布）；当前安装 0.1.1-rc.1（`dsh --version` 与 package.json 一致，检测准确），最新 0.1.1-rc.2。已改为完整版本号 + 来源标注 + 检查更新。
- **Windows sharp DLL 锁**：harness 运行中（本机即如此）`npm install -g dsh` 会因 sharp 原生 DLL 被占用而失败——故安装/更新前拦截运行中环境并提示。

### 结果 / 状态（实测）
- P3 20/20：环境 CRUD（含非法名 400、运行中拦截）、installedNames、版本状态（base 探测 0.1.1-rc.1 / latest 0.1.1-rc.2）、base 注册与激活、运行中安装 409、init-home、重置 data/all。
- P3-B：并列环境真实 `npm --prefix` 安装 → 激活 → 删除（目录清除）。
- 回归 63/63：快修 19 + 统一内核 12 + 分配 10 + P1 12 + P2 10。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过。

### 下一步
- 桌面版 v0.2.0 重建（make-release）；可选：托盘/通知、批量启停、端口可视化、内容级 i18n、GitHub Actions。

---

## [2026-08-27] v0.2.1：版本自愈修复 + 版本下拉 + dsh 全删除 + 审计文档

### 用户反馈
- dsh 环境版本"测不出来"；并列环境版本要选项框而非手输；重置需增加"dsh 全删除（含删除所有 dsh 内容）"；改进打包后做可行性/可迁移性/安全性/卸载检查与过程备份文档。

### 修复
1. **版本自愈**：`DshEnvManager.ensureBaseRegistered()`——若未注册 base 但检测到 dsh（npm 全局优先），自动注册；`status()` 新增 `currentVersion`（激活环境 → base → 首个检测）与 `detectedCount`；控制台/顶栏/DSH 环境页统一显示"当前实际使用版本"。
2. **并列环境版本下拉**：新增 `GET /api/dsh/versions`（npm 已发布版本列表 + 本地检测）；前端改为 `<select>`（最新版默认 + 已发布版本），不再手输。
3. **重置增加 dsh 全删除**：`POST /api/reset { scope: 'dsh-all' }` = 停止全部环境 → 删除所有 Profile → 卸载全局 dsh（npm uninstall -g）→ 删除整个 DSH_HOME → 删除受管并列环境目录 → 清空数据文件；UI 需**输入 DELETE** 强确认。
4. **检测 / npm 查询缓存**：detect 5s、latest/versions 60s 独立缓存，修复"查最新版把版本列表缓存成空"的 bug，并避免轮询拖慢接口。
5. **审计文档**：`docs/audit/` 新增《可行性检查》《可迁移性检查》《安全性检查（行业标准）》《卸载项目检查》《项目所有过程保留备份》。

### 事故与恢复（记录）
- 早前测试触发的 `npm install -g`（sharp/koffi 原生 DLL 被运行中的 harness 锁定）导致**本机全局 dsh 包损坏**（文件被删、shim 丢失）。已实测恢复：包文件完好时**手动重建 npm 标准 shim**（dsh.cmd / dsh.ps1 / dsh）即可；`dsh --version` 恢复 0.1.1-rc.1。Launcher 侧已加"运行中拦截安装"避免再次触发。
- 用户执行重置清空了本机真实 profiles（现仅剩官方 web 模板）——重置语义确认无误，UI 确认已加强。

### 结果 / 状态（实测）
- P3 扩至 **29/29**（新增：重置后 base 自愈 P21–P22、currentVersion P23–P24、版本列表 P25、dsh-all P26–P29）。
- 卸载实测：静默安装 → `uninstall.exe /S` → exit 0、目录全清。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过。

### 下一步
- 安全加固（CORS 收紧、dsh-all 路径二次确认、安全响应头）；托盘/通知；GitHub Actions 自动打包。

---

## [2026-08-27] 下一迭代：拖拽全面化 + 市场批量安装/排序 + 性能优化 + 删除增强

### 目标（按《提示词.md》四项）
- 拖拽全面化：可用插件区作为拖拽源，拖入任意环境即新建分配（不再依赖输入 ID）。
- 插件市场：批量安装（队列进度 1/3、2/3…）+ 热门/最新排序 + 失败标出具体包。
- 运行速度：合并轮询（/profiles/status）、按页代码分割（React.lazy）、市场缓存（已有）。
- Profile 删除增强：卡片 🗑️ 按钮 + 输入环境名确认 + 批量删除。

### 改动
- **后端（server.ts）**：
  - 新增 `POST /api/profiles/:name/plugins/batch`（串行安装，逐包返回 { pkg, ok, error }，含来源策略校验）。
  - 新增 `GET /api/profiles/status?names=a,b,c` 合并轮询接口（轻量运行状态，不扫描磁盘详情）；抽出 `profileStatusView` 供 `/profiles` 复用。
- **前端**：
  - `MarketPage.tsx`：卡片复选框多选、「批量安装（N）」串行队列（⏳等待 → 🔄安装中 → ✅完成 / ❌失败+原因）、进度条（已处理/总数）、排序下拉（默认 / 🔥 热门按下载量 / 🆕 最新按更新时间）、已装插件禁选。
  - `ProfilesPage.tsx`：每张卡片新增 🗑️ 删除按钮（运行中禁用 + Tooltip）；删除确认改为自定义对话框——**需输入环境名**才能确认；工具栏支持勾选批量删除（需输入 DELETE 确认）；3s 轮询改为合并接口 `profilesStatus`。
  - `AllocationsPage.tsx`：每个环境面板新增「可用插件」拖拽区（已安装依赖 + bundles），插件 chip 可**拖到任意环境面板即分配**（保留点选添加）；拖拽高亮 drop-target。
  - `App.tsx`：7 个页面全部改为 `React.lazy` + Suspense 按页代码分割（首屏只加载当前页）。
  - `components.tsx`：新增通用 `ConfirmDialog`（输入指定文字才可确认，Esc/点击遮罩关闭）。
  - `api.ts` / `types.ts`：`installPluginsBatch`、`profilesStatus`、`ProfileStatus`、`BatchInstallResult`。
  - `styles.css`：复选框/选中卡片、删除按钮、确认对话框、批量安装队列面板、可用插件拖拽区、drop-target 高亮样式。

### 结果 / 状态（实测）
- 隔离环境冒烟 **17/17**：合并轮询返回多环境轻量状态；批量安装空数组 400、git 来源被策略拒绝并逐包返回、空包名拒绝、失败计数；available 清单（依赖/bundle 来源、分配后标记 allocated）；新建分配、跨 Profile 移动、删除分配、删除环境全链路。
- `pnpm typecheck` / `build:server` / `build:web` 全部通过；vite 产物按页分包（每页独立 chunk，index 160KB）。

### 下一步
- 数据文件合并（5 个小 JSON → state.json，属高风险迁移，本轮未做，建议独立迭代验证）；懒加载 Profile 详情（当前仍全量扫描，可后续按需）；日志 SSE 流式；托盘/通知；GitHub Actions 自动打包。

---

## [2026-08-27] v0.2.2 发布：升级版本号 + 打包 + 备份 + 版本号显示修复

### 目标
- 完成上一轮（拖拽/市场/性能/删除）迭代的版本升级与发布打包，按用户要求「打包备份升级版本号」。

### 改动
- **升级 0.2.1 → 0.2.2**：`scripts/bump-version.ps1` 统一更新全部 package.json / Cargo.toml / tauri.conf.json / data/config.json。
- **备份**：`_backup/dsh-launcher-project-0.2.1-pre-0.2.2/`（源码不含 node_modules/dist/target + release 产物）。
- **打包**：`make-release.ps1 -Version 0.2.2` → `release/dsh-launcher-0.2.2-x64-setup.exe` + `-x64.zip` + `SHA256SUMS.txt`（tauri build 内嵌前端 + custom-protocol，WebView2Loader.dll 在 exe 旁）。
- **修复（打包中发现）**：
  1. `bump-version.ps1`：根 package.json `Get-Item` 空引用 bug；`Set-Content -Encoding UTF8` 写 BOM 导致 serde_json 解析失败 → 改为 `Write-NoBom`（`UTF8Encoding($false)`）+ 末尾无 BOM 校验；新增同步 `config-store.ts` 的 `DEFAULT_CONFIG.launcher.version`。
  2. `config-store.ts`：`readConfig` 中 launcher 版本号不再被用户 `data/config.json` 残留旧版本覆盖（launcher 是应用元数据），升级安装后 `/api/health` 正确显示新版本。
- 新增 `docs/改进建议-0.2.2.md`：A 工程健壮性 / B 性能 / C 功能 / D 已完成回顾 / E 下轮顺序。

### 结果 / 状态（实测）
- `pnpm typecheck` / `build:server` / `build:web` 通过；冒烟 17/17。
- 打包后运行桌面版（含旧 APPDATA config 残留场景）：窗口「dsh Launcher」打开、后端 4780 就绪、`launcher.version=0.2.2`、前端 200。
- 排查记录：首次验证显示 0.2.1 是**残留旧后端进程占用 4780 端口**导致 health 来自旧进程（清理后正常），与打包无关。

### 下一步
- 按《改进建议-0.2.2.md》：CORS 收紧 → 统一内核按环境开关 → Profile 懒加载 → 批量启停 → 单测 → SSE 日志 → 端口可视化 → 虚拟滚动 → 托盘 → GitHub Actions。

---

## [2026-08-27] A 组防灾难：git 版本控制 + patch 写回守护 + CORS/安全头

### 目标（按《改进建议-0.2.2.md》决策组 A）
- 给项目建立版本控制（此前无 git，无法回滚）。
- 给「写回 cordis.patch.yml」加可解析性守护：patch 含无法理解的结构时拒绝写回，防止破坏用户配置。
- CORS 收紧：同源默认不放行跨域，仅显式配置来源才放行；补安全响应头。

### 改动
- **A1 git**：`git init` + 首次提交 + tag `v0.2.2`；`.gitignore` 排除运行时数据（data/* 仅留 .gitkeep）与 release 二进制。
- **A2 patch 守护**：
  - `patch.ts` 新增 `checkPatchParsable()`（识别空行/注释/顶层 op/`- id`/`disabled|enabled`/空数组 `[]`，其余行视为无法识别）与 `readPatchChecked()`（含不可解析结构时抛错，附行样本）。
  - `allocation-manager.applyProfile`：写回前 `readPatchChecked` 守护 + 写回前备份原 patch 到 `data/patches-backup/<profile>-<时间戳>.yml`。
  - `profile-editor.setPluginDisabled`：同样使用 `readPatchChecked`。
  - `server.ts`：分配 POST/PATCH/DELETE/reorder 写回失败时**回滚并返回 409**（此前 201/200 + applyError，会造成「UI 显示已分配但实际未生效」的不一致）；幂等重复分配不误删既有条目。
- **A3 安全**：
  - 新增配置 `allowedOrigins`（默认空 = 仅同源）；`corsHeaders()`/`securityHeaders()` 辅助。
  - `sendJson`、OPTIONS 预检、静态资源统一加安全头（nosniff / no-referrer / no-store）。
  - `PUT /api/settings` 支持 `allowedOrigins`，保存后即时生效（不再依赖重启）。

### 结果 / 状态（实测）
- A 组冒烟 **11/11**：同源无 ACAO 头、安全头齐全、配置 allowedOrigins 后放行、正常 patch 分配写回+备份生成、复杂 patch 拒绝写回（409 + 行样本 + 分配回滚）、拒绝后原文件原样保留。
- `pnpm typecheck` / `build:server` 通过。

### 下一步
- B 组：server.ts 按资源域拆分（999 行 → 多个 route 模块）→ `node:test` 单测（patch/alloc/unified-kernel）→ 冒烟自动化。

---

## [2026-08-27] B 组稳根基：server 按资源域拆分 + 单元测试 + 冒烟自动化

### 目标（按《改进建议-0.2.2.md》决策组 B）
- 可维护性：把 1048 行巨型 `handleApi` 按资源域拆分为独立 route 模块。
- 回归保护：为「会写用户文件」的三块核心逻辑补 `node:test` 单元测试。
- 自动化：隔离冒烟脚本纳入 `pnpm test:smoke`。

### 改动
- **B1 server 拆分**：
  - 新增 `apps/launcher/src/routes/`：`types.ts`（`RouteContext` 共享上下文 + `ApiHandler` 契约）、`profiles.ts`、`allocations.ts`、`market.ts`、`kernels.ts`（含 unified-kernel）、`dsh.ts`、`settings.ts`、`index.ts`（路由汇总）。
  - `server.ts` 精简为装配器：runtime 恢复、上下文装配、`/api/health`、OPTIONS/静态服务，按序分派到 route handlers，未命中 404。
  - 路由间共享运行态通过 `RouteContext`（running Map、installTasks、marketCache、allowedOrigins 引用、sendJson/辅助函数）。
- **B2 单元测试 20/20**（`node --import tsx --test`）：
  - `patch.test.ts`：解析（规范/多 op/注释引号）、序列化往返、`checkPatchParsable`（嵌套/`!!js`/`$patch` 识别）、`readPatchChecked` 抛错与行样本。
  - `allocation-manager.test.ts`：分配幂等、启用/排序/删除往返、applyProfile 保留用户条目、空文件不创建、不可解析拒绝且不破坏原文件、备份生成、removedIds 清理。
  - `unified-kernel.test.ts`：幂等注入（web-app 紧跟 dsh-base）、用户插件追加/禁用项跳过、精确还原保留用户条目、reorder。
- **B3 冒烟自动化**：`scripts/run-smoke.ps1`（预清理测试端口 + Start-Process 运行子脚本 + 超时兜底）聚合 `scripts/smoke/` 下 4 组隔离冒烟（v021/A组/alloc/p2），`pnpm test:smoke` 一键执行。
- 修复 `checkPatchParsable` 的 disabled/enabled 正则 bug（trimmed 已去缩进但正则要求前导空格 → 不匹配，导致规范 patch 被误判为不可解析）。

### 结果 / 状态（实测）
- 拆分后用**新构建产物**全量回归：v021 17/17、A 组 11/11、alloc、p2 全部通过（与拆分前一致，零行为变化）。
- `pnpm test`（20 单测）、`pnpm test:smoke`（4 组冒烟）、`pnpm typecheck`、`build:server`、`build:web` 全部通过。
- 排查记录：早期冒烟误报失败多为**残留测试进程占用固定端口**（脚本被中断后 server 未清理），run-smoke 已加端口预清理；`_smoke.ps1`/`_smoke-p1`/`_smoke-p3`/`_smoke-unified` 依赖真实 dsh 启动或历史 `_extracted` 产物，不纳入自动化。

### 下一步
- C 组增值：统一内核按环境开关 → 环境批量启停 → 端口占用可视化；贯穿：dsh CLI 适配层隔离 + 每轮更新文档。

---

## [2026-08-27] C 组增值：统一内核按环境开关 + 批量启停 + 端口占用可视化

### 目标（按《改进建议-0.2.2.md》决策组 C）
- C1：统一内核从「全局开关」升级为「按环境覆盖」（强制注入 / 跳过注入 / 跟随全局）。
- C2：环境页勾选后批量启动/停止（与批量删除体验对齐）。
- C3：端口占用可视化，冲突诊断从文字变可操作。

### 改动
- **C1 统一内核按环境覆盖**：
  - `unified-kernel.ts`：`UnifiedKernelConfig` 新增 `byProfile: Record<string, boolean>`；`setProfileOverride(profile, enabled|null)`；`desiredBundles(cfg, profile)` 按覆盖计算（覆盖优先于全局开关）；`revertFromAll` 跳过 byProfile=true 的环境（强制注入不被全局禁用误还原）。
  - 后端 `PUT /api/unified-kernel/profile/:name { enabled: boolean|null }`：保存覆盖并即时生效（true→应用到该环境；false/null→还原该环境）。
  - 前端 `KernelsPage`：统一内核卡新增「按环境覆盖」区——每个环境一个下拉（跟随全局 / 强制注入 / 跳过注入）。
- **C2 环境批量启停**：`ProfilesPage` 勾选后工具栏新增「▶ 批量启动」「⏹ 批量停止」（串行执行，跳过已运行/未运行的，汇总成功/跳过/失败）。
- **C3 端口占用可视化**：
  - `core/process-manager.ts` 新增 `findProcessName(pid)`（Windows tasklist 反查进程名）。
  - 后端 `GET /api/ports`：当前运行端口 + 状态 + 真实 pid + 进程名 + URL（按端口排序）。
  - 前端 `ProfilesPage` 工具栏「🖧 端口」按钮 → 端口面板（环境/端口/进程/PID/打开链接）。
- 冒烟：新增 `scripts/smoke/_smoke-c-group.ps1`（C1 覆盖注入/跳过/清除、C3 端口视图），纳入 `pnpm test:smoke`。

### 结果 / 状态（实测）
- C 组冒烟 **8/8**：默认无覆盖、alpha 跳过注入（beta 正常注入）、清除覆盖后跟随全局注入、端口视图字段完整。
- `pnpm test:smoke` 五组全绿（v021 17/17 + A 11/11 + C 8/8 + alloc + p2）；`pnpm test` 20/20；typecheck / build 全过。
- 修复：`run-smoke.ps1` 临时文件清理延迟（子进程句柄释放），根治「文件被占用」导致的误报 exit=1。

### 下一步
- 贯穿项：dsh CLI 适配层隔离（pluginAction/detect 输出格式变化时的唯一改点）+ 内容级 i18n + GitHub Actions 自动打包。
