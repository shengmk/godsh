# 为下一个 AI 编程对话的资料和输入

> 本文件是 **dsh Launcher** 项目交接给下一个 AI 编程会话的**完整输入**。
> 请新会话先完整阅读本文件，再读 `PROMPT.md`、`docs/iteration-log.md`、`docs/dsh-study.md`，然后开始工作。
> 目标：让新 AI 在**不依赖旧会话记忆**的情况下，快速理解项目全貌、当前状态、技术约束与下一步方向。

---

## 0. 一句话概括

**dsh Launcher** 是 DeepSeek Harness（dsh）的图形化环境配置启动器（类比 Anaconda Navigator）：管理 DSH 的 Profile（环境）、插件分配、Web 内核与 DSH 本体版本；Windows 桌面（Tauri 2）+ Web 双形态。

**当前版本：v0.2.4**（git 13 个提交，仓库干净，release 产物齐全）。

---

## 1. 项目目的与类比

| Anaconda | DSH | dsh Launcher |
| --- | --- | --- |
| Anaconda Navigator | dsh web / CLI | 本启动器 |
| conda | dsh CLI | 启动器底层调用 |
| Python | DeepSeek Harness 核心 | dsh 本体 |
| conda env | DSH Profile | 环境管理 |
| pip/conda 包 | dsh plugin / bundle | 插件分配与安装 |
| conda channel | dshmarket / awesome-dsh-plugin | 插件市场 |

**核心价值**：把 dsh 的命令行操作（环境启停、插件安装/分配、版本管理）变成可视化、拖拽化、一键化；同时让**没有 dsh-web-app 的 Profile 也能启动出 Web UI**（统一内核）。

---

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js ≥ 20 · TypeScript ESM · 纯 `node:http`（零框架）· esbuild 单文件 `server.mjs`（~120KB） |
| 前端 | Vite 5 · React 18 · TS · 玻璃拟态 CSS（浅色 + 深色）· `React.lazy` 按页分包（7 页独立 chunk） |
| 桌面 | Tauri 2（Rust，`crate-type=["rlib"]`，GNU/MinGW 工具链）+ WebView2 · 自包含（后端 + 模板打进资源） |
| 安装 | 自定义 NSIS（exe 旁放 WebView2Loader.dll）+ 便携 ZIP |
| 测试 | `node:test` 单元测试（3 个文件 / 20 用例）+ PowerShell 冒烟回归（6 个脚本） |
| 包管理 | pnpm workspace monorepo（`tsx` 直跑，ESM + `moduleResolution: Bundler`） |

---

## 3. 目录结构

```text
dsh-launcher-project-0.2.2/
├─ apps/
│  ├─ launcher/            # 主应用：CLI + HTTP API + Tauri 桌面壳
│  │  ├─ src/
│  │  │  ├─ cli.ts         # CLI 入口（detect/profiles/start/...）
│  │  │  ├─ context.ts     # 共享上下文（manager 装配）
│  │  │  ├─ server.ts      # HTTP API 装配器（路由分派 + 静态服务）
│  │  │  └─ routes/        # 按资源域拆分的 API 路由（8 个文件）
│  │  └─ src-tauri/        # Tauri 桌面壳（lib.rs 拉起后端 + resources）
│  └─ shell-web/           # Web 管理界面（src/pages/ 7 页 + i18n + theme）
├─ packages/               # 8 个业务包
│  ├─ core/                # 环境检测、进程管理、配置存储、路径、run
│  ├─ profile-manager/     # Profile 扫描/创建/删除 + cordis.patch.yml 解析
│  ├─ plugin-registry/     # bundle/client 插件识别
│  ├─ allocation/          # 插件分配（含 patch 写回守护 + 备份）
│  ├─ kernel-manager/      # 内核模板/实例 + 统一内核（bundle 注入 + 按环境覆盖）
│  ├─ marketplace/         # `dsh plugin` 封装 + 市场索引缓存
│  ├─ dsh-env/             # DSH 本体环境（base/managed/external）
│  └─ security/            # 来源校验、构建授权
├─ scripts/                # bump-version / make-release / build-tauri / run-smoke + smoke/ 冒烟脚本
├─ docs/                   # 设计文档 + iteration-log.md + audit/
├─ kernels/templates/      # 内核模板
├─ profiles/ plugins/      # 示例
├─ data/                   # 运行时数据（gitignore）
├─ release/                # 发布产物（setup/zip/SHA256/RELEASE_NOTES）
└─ .github/workflows/      # GitHub Actions 自动打包（release.yml）
```

---

## 4. 当前功能全景（v0.2.4 全部可用）

### 4.1 七页导航
控制台 / 环境 / 插件市场 / 插件分配 / 内核管理 / DSH 环境 / 设置（Ctrl+1..7 切换，无数字角标）。

### 4.2 环境（Profile）管理
- 扫描/新建/删除/启停；运行状态徽标（运行中/启动中/已停止/启动失败）
- 合并轮询 `GET /api/profiles/status?names=a,b,c`（3s 一次请求返回全部）
- 批量启停（勾选 → ▶ / ⏹）；批量删除（需输入 DELETE 确认）
- 卡片 🗑️ 删除（需输入环境名确认，运行中禁用）
- 🖧 端口占用视图（`GET /api/ports`：端口 + PID + 进程名）
- 每环境指定 dsh 版本下拉
- 启动阶段诊断（进程提前退出/超时 → error + 日志尾部 + 常见原因）

### 4.3 插件市场
- 搜索（300ms 防抖）、中文描述优先、分类/星标/下载量
- 排序：默认 / 🔥热门（下载量）/ 🆕最新（时间）
- 单装/更新/卸载 + **批量安装队列**（多选 → 进度 1/N → 失败标出具体包）
- 后端 `POST /api/profiles/:name/plugins/batch`（串行、逐包结果）

### 4.4 插件分配（本轮重点，已重构为 Pointer Events 拖拽）
- **每个环境内统一列表**：已分配卡片 + 可用插件（未分配）混排，**全部可拖动**
- **同环境拖拽排序**（写回 `cordis.patch.yml`）
- **跨环境拖拽移动**（如 plugin_bag → desktop）：已分配卡片移动；可用插件需目标环境已安装
- 可用插件拖入分配区即分配；启用/禁用、上移/下移、移除、右键菜单
- **拖拽引擎**：自研 Pointer Events（pointerdown → pointermove 5px 阈值 → pointerup），**不再用原生 HTML5 DnD**（WebView2 下 drop 不触发）
- 跟手 ghost 提示 + 插入位置线（drop-line）

### 4.5 统一内核
- 把 `@deepseek-ai/dsh-web-app` + 用户偏好插件注入 Profile 的 `dsh.profile.bundles`（**不是 `--patch`**！实测 `--patch` 缺 webServer 服务会启动失败）
- **按环境覆盖**：每环境下拉「跟随全局 / 强制注入 / 跳过注入」
- 只移除本工具添加的条目（managed 记录），不污染用户配置

### 4.6 DSH 环境 / 设置
- base 主环境 + 并列环境（npm --prefix 受管目录）+ 外部检测；版本自愈注册
- 版本显示（currentVersion）+ npm 最新版提示 + 并列环境版本下拉（npm 已发布列表）
- 主题（浅/深/跟随系统）、语言（中/英）、路径、市场 URL、数据备份/恢复、重置（data/all/dsh-all）、卸载

---

## 5. 关键技术机制（必须理解的 DSH 真实事实）

1. **`dsh web` 是 `--profile web` 的硬编码别名**，不接受 `--profile`。
   启动任意 Profile 的 Web UI 正确命令：`dsh --profile <name> --port <port> --no-open`（无 `web` 字样）。
2. **统一内核用 bundle 注入而非 `--patch`**：Web 表面由 dsh-web-app **bundle 自带的 cordis.patch.yml** 提供（几十行），`--patch` 只插行会因缺 webServer 服务启动失败。
3. **Windows shim/pid 陷阱**：`dsh` 走 cmd shim，pid 文件记录 shim pid；API 重启后 shim 已退出、真实 dsh（node）被孤儿化但仍监听端口 → 用 `findPidByPort`（netstat 反查）判活/停止。
4. **CORS 白名单**：默认允许 `http://tauri.localhost` / `tauri://localhost` / `http://localhost`（桌面端前端跨域访问 127.0.0.1:4780 必需）；`corsHeaders` 按请求 Origin 精确匹配回显。
5. **patch 写回守护**：`readPatchChecked` 拒绝含嵌套配置/`!!js`/`$patch` 的不可解析结构；写回前备份到 `data/patches-backup/`；分配写回失败回滚 + 409。
6. **拖拽引擎选型教训**：WebView2 对原生 HTML5 DnD 的 drop 不稳定 → 已改 Pointer Events 自研引擎。

---

## 6. 工程现状

- **git**：13 个提交，tag 未打（建议发布后打 `v0.2.4`）。历史从 v0.2.2 重建（旧历史随目录操作丢失，源码完整）。
- **测试**：`pnpm test`（20 单测：patch/allocation/unified-kernel）、`pnpm test:smoke`（6 组冒烟：v021/A组/C组/cross-drag/alloc/p2）。
- **冒烟注意**：脚本用固定端口（48231/48329/48321/48461/47896/47902），`run-smoke.ps1` 预清理；被宿主 DSH Desktop 占用的端口已避开。
- **已知问题**：冒烟输出 `smoke-*.txt` 在工作区根可能被宿主锁定无法删除（已 gitignore）；`_smoke.ps1`/`_smoke-p1`/`_smoke-p3`/`_smoke-unified` 是历史脚本（引用 `_extracted` 旧产物/依赖真实 dsh），不在自动化范围内。

---

## 7. 构建与发布命令

```powershell
pnpm install          # 安装依赖（esbuild 二进制缺失时用 --ignore-scripts + 手动校验）
pnpm typecheck        # 全量类型检查
pnpm test             # 单元测试
pnpm test:smoke       # 冒烟回归
pnpm build:server     # esbuild → apps/launcher/dist/server.mjs
pnpm build:web        # tsc + vite → apps/shell-web/dist
pnpm serve            # 启动 API + 托管前端（127.0.0.1:4780）
pnpm launcher help    # CLI

# 版本升级（自动同步全部 package.json / Cargo.toml / tauri.conf.json / config.json / config-store.ts）
pwsh -File scripts/bump-version.ps1 -Version 0.2.5

# 发布打包（build:server → build:web(tauri) → tauri build 内嵌前端 → NSIS + ZIP + SHA256）
pwsh -File scripts/make-release.ps1 -Version 0.2.5
```

> GNU 工具链限制：构建要求项目路径不含空格（`make-release.ps1` 内部复制到 `%USERPROFILE%\dshlauncher`）。

---

## 8. 下一步方向（按优先级，供新会话规划）

### P0（安全/稳健，建议先做）
1. **CORS 响应头完善**：当前 ACAO 精确回显 OK，但可加 `Access-Control-Max-Age` 预检缓存、`Content-Security-Policy`（前端静态资源）。
2. **可用插件顺序持久化**：目前可用↔可用排序仅前端本地；如需持久化，需在 `available` 接口加 order 或引入候选排序存储。
3. **未分配插件跨环境「需先安装」体验**：目前提示"请先在市场安装"；可一键跳转市场或给出安装链接。

### P1（功能增强）
4. **拖拽到收起的环境面板**：当前跨环境拖拽目标需展开面板；可支持拖到收起面板自动展开定位。
5. **右键菜单「移动到…」**：非拖拽用户的备选路径（列出目标环境）。
6. **内核实例端口冲突检测**：启动前检查端口占用并提示（已有 `GET /api/ports`，可联动）。
7. **数据备份增强**：定时自动备份到 `data/backups/`（保留 N 份）。

### P2（体验/工程）
8. **内容级 i18n**：市场卡片描述按语言切换（zh/en 字段已有）、Toast 文案抽语言包。
9. **SSE 日志流**：替代 2s 轮询（环境/内核日志）。
10. **GitHub Actions 验收**：`.github/workflows/release.yml` 已备好，首次推送 tag 时验证自动打包。
11. **Tauri 托盘 + 系统通知**（需 Rust 侧）。
12. **dsh CLI 适配层隔离**：`pluginAction`/`findDshInstances` 输出解析集中封装，应对 dsh 版本演进。

### 明确不做（防过度工程）
- ❌ 5 个小 JSON 合并 state.json（风险高收益低，两轮已否决）
- ❌ 引入前端状态管理库/UI 框架（useState 足够）
- ❌ 每插件一个浏览器（违反 DSH 统一 Web 内核原则）

---

## 9. 工作规范（新会话必须遵守）

1. 动手前先读本文件 + `PROMPT.md` + `docs/iteration-log.md` + `docs/dsh-study.md`。
2. 不直接改 DSH 源码；通过 CLI 和文件配置驱动。
3. 不手工改 node_modules；插件安装/卸载走 `dsh plugin` 或 pnpm。
4. 所有 client 插件共享同一 Web 内核，不设计"每插件一个浏览器"。
5. 插件分配最终落到 `cordis.patch.yml`（通过 `allocation` 包，带守护 + 备份）。
6. 改代码的同时更新 `docs/iteration-log.md` 与相关文档。
7. 每轮完成跑 `pnpm typecheck` + `pnpm test` + `pnpm test:smoke`；发布用 `make-release.ps1`。
8. **不要删除工作区根的历史 md 文档**（用户明确保留：优化方案大纲.md、大纲.md、提示词.md、改进点、项目文件总结等）。
9. 冒烟输出重定向到项目外（`$env:TEMP`）或确认 gitignore 覆盖，避免误提交 `smoke-*.txt`。

---

## 10. 关键文档索引

| 文档 | 用途 |
| --- | --- |
| `PROMPT.md` | 常驻 AI 开发提示词（角色/原则/禁止事项） |
| `docs/iteration-log.md` | 完整迭代历史（v0.1.0 → v0.2.4） |
| `docs/dsh-study.md` | DSH 框架学习笔记 |
| `docs/folder-config.md` / `docs/workflow.md` | 文件夹/流程说明 |
| `优化方案大纲.md` / `改进点（功能与界面）.md` | 下一迭代输入提示词与清单 |
| `项目文件总结.md` | 项目文件全貌 |
| `README.md` / `QUICKSTART.md` / `使用说明.md` | 用户文档 |
| `发布到GitHub指南.md` | GitHub 上传教程 |
| `验收清单-0.2.2.md` | 验收清单示例 |
