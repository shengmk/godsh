## [0.6.0] - 2026-09-09

全局 UI/UX 电影级重构（Cinematic Dark + Glassmorphism）与无控制台启动优化。

### 🛡️ 无黑窗启动 (P0)
- **CREATE_NO_WINDOW**：在 Tauri Rust 核心层通过 `CREATE_NO_WINDOW = 0x08000000` 注入，彻底消除启动时弹出的 node.exe / cmd.exe 黑窗；
- **全生命周期静默托管**：后端子服务与命令行操作全部转为后台静默管道托管。

### 🎨 电影级环境底座与设计令牌
- **Cinematic Dark**：OLED 纯黑 `#020203` 底板结合现代微光毛玻璃拟态 `backdrop-filter: blur(20px)` 与发丝微光边框 `rgba(255,255,255,0.08)`；
- **流光点阵图层**：天顶散射微蓝 (`0.14`)、右下极光紫 (`0.09`) 与 24px 网格点阵微光叠加；
- **矢量图标系统全覆盖**：100% 根除所有 Raw Emoji，全量引入 `lucide-react` 精密矢量图标。

### 📊 七大业务功能页面全量看板化
- **Profiles / Allocations / Vault / Tasks / Market / Kernels / Settings** 7 大页面全面看板化重构，32px 超紧凑高密度数据表格、鼠标框选多选（AABB碰撞算法）与双轨启动唤起。

### 🧩 实用性防御与键盘无障碍体系
- **空状态组件 (EmptyState)**：虚线微光边框、弥散光环与场景化引导；
- **微光渐变骨架屏 (CSS Shimmer)**：平滑流光骨架替换纯文字 Loading；
- **React 错误边界 (ErrorBoundary)**：组件级故障隔离自愈；
- **触控热区与键盘导航**：按钮热区扩展 `≥ 44×44px`，支持全局 `Esc` 退出与 `Ctrl+K` 聚焦搜索；
- **零横向溢出防御**：容器与文本截断保护，视口严丝合缝。

### ⚡ 阻尼物理按压与极客终端微质感
- **机械按压阻尼**：交互元素引入 `cubic-bezier(0.16, 1, 0.3, 1)` 弹性曲线，`:active { transform: scale(0.975); }`；
- **全色系状态呼吸灯**：翠绿、琥珀、绯红、靛蓝四色动态呼吸光晕环；
- **极客终端 CRT 扫描线**：水平扫描线微纹理（`pointer-events: none`），4px 超细发丝荧光滑轨；
- **流体弹簧转场**：弹窗与抽屉 `@keyframes modal-spring-enter` 180ms 回弹展开。

### 🔍 自动化视觉检查方案
- 联合 `paicat1/dsh-screenshot` 与 `liustack/modlens` 构建桌面 WebView2 自动化视觉质检闭环 (`09_输入文档/方案.md`)。

## [0.5.5] - 2026-09-08

升级为环境可靠性中心（Environment Reliability & Control Center）与 DSH Desktop 深度兼容。

### 🔄 沙箱更新 Bug 根治与同步感知
- **Pre-flight 物理连通性与孤立引用清扫**：在 `vault.updatePlugin` 执行前后进行自动环境校验，自动剔除已在外部物理删除的环境残留索引，杜绝无意义重试与静默挂死；
- **颗粒化同步状态反馈**：更新流程支持各环境独立结果跟踪（`updated` / `pruned` / `failed`），并在前端精确反馈更新感知。

### ⏳ 时光机备份与回退系统 (Time Machine Backup & Rollback)
- **多维度快照元数据**：每份快照携带 `SnapshotMeta`（关联 Profile、触发来源、创建时间、文件指纹、保留锁定标记等）；
- **快照生命周期管理**：支持快照防误删锁定（Lock/Unlock）、智能过期淘汰清理（Retention Policy）、存储用量统计；
- **原子级安全回滚**：在执行快照回滚前自动生成安全备份（Safety Snapshot），遇到异常可无损恢复；
- **结构化审计日记**：核心操作（快照、回滚、自愈、修复）自动沉淀至 `godsh-journal.jsonl` 与 `godsh-journal.log`，支持历史审计追溯。

### 🩺 7 阶段自愈工作流引擎 (7-Phase Repair Agent)
- **全自动多阶段自愈流水线**：
  1. `PhaseInspection`：底层依赖校验与环境健康体检；
  2. `PhaseQuarantine`：异常与死链依赖安全隔离；
  3. `PhaseCheckpoint`：自愈前强制生成原子快照；
  4. `PhaseRestore`：环境配置与历史备份重置矫正；
  5. `PhaseDependencyHeal`：核心包与软链自动重建补偿；
  6. `PhaseVerify`：预检验证与启动门禁复测；
  7. `PhaseBootAndReport`：健康验证启动与完整执行报告归档。
- **后台异步化与任务流追踪**：自愈全过程在独立工作流任务中执行，支持实时日志推流与进度查询。

### 🖥️ 系统任务监控中心与实时终端 (`/tasks` & SystemTasksPage)
- **全局任务仪表盘**：统一监控环境自愈、沙箱更新、快照备份、依赖安装等全系统后台异步任务；
- **极客风格终端面板**：内置黑色 Glassmorphism 实时日志终端，支持自动滚动锁定与日志即时高亮；
- **操作审计历史列表**：直观展示历史操作记录、耗时与执行状态，支持日志一键清理与筛选。

### 🚀 DSH 官方桌面版 (DSH Desktop) 深度兼容
- **双轨启动通道**：环境列表支持选择使用 Web 版或唤起 DSH 官方桌面版（DSH Desktop）；
- **状态无缝穿透同步**：主动探测并实时同步 `%APPDATA%\DSH Desktop\profile-selection\state.json`，确保桌面版唤起时精准激活对应 profile；
- **Profile Bundle 顺序净化规范**：确保 `@deepseek-ai/dsh-base` 置顶紧随 `@deepseek-ai/dsh-web-app`，彻底剔除已废弃的启动器专属包，保障桌面版稳定运行。

### 🧪 单元测试扩充
- 全仓 69 项自动化单元测试 100% 通过（pass 69 / fail 0）；
- TypeScript 类型检查 0 错误；Web 构建 0 错误 0 警告；Tauri release NSIS 官方安装器与绿色便携包输出。

## [0.5.4] - 2026-09-08

全维环境体检引擎 (godsh doctor)、毫秒级启动预检门禁、P0 级重解析点穿透隔离防御与原子级自愈闭环。

### 🩺 全维环境体检与 API 落地 (godsh doctor)
- **原生 TypeScript 六层体检流水线**：
  - Layer 0 (全局 CLI)：验证 DSH 全局安装状态与运行时版本匹配度；
  - Layer 1 (网络监听)：对齐系统网络端口占用与真实存活 PID；
  - Layer 2 (HTTP 状态)：探测 Web 端口心跳与接口连通性；
  - Layer 3 (配置与占位符)：精准识别破损占位符与非法残存死链；
  - Layer 4 (Patch 状态)：深层校验 `cordis.patch.yml` 语法合规性；
  - Layer 5 (Junction 软链状态)：扫描死软链并杜绝直连宿主 CLI 的高危软链。
- **命令行与 RESTful API 双向赋能**：新增 `godsh doctor [profile] [--fix]` 命令行；暴露 `/api/doctor/diagnose`、`/api/doctor/preflight`、`/api/doctor/heal`、`/api/doctor/safe-clean` 服务端点。

### ⚡ 毫秒级启动预检门禁 (Pre-flight Gatekeeper)
- **前置阻断闪退**：在环境启动 (`/api/profiles/:name/start`) 前注入毫秒级门禁；遇占位符死链或致命配置破损前置拦截并返回结构化 `preflightBlocked` 诊断及一键自愈引导。

### 🛡️ P0/P1 重解析点穿透隔离防御 (Anti-Penetration)
- **重置隔离安全栅栏（P0 根治）**：在重置 Profile 目录前强制注入 `safePurgeProfileJunctions`，先剥离全部 Junction 再清空物理文件，彻底杜绝顺着软链清空宿主全局 CLI 依赖。
- **环境删除隔离屏障（P0 根治）**：在 `removeProfile` 中清除环境物理目录前彻底剥离重解析指针。
- **废除解绑递归降级（P1 根治）**：在 `safeUnlinkJunction` 中彻底废除 `rmSync(..., { recursive: true })` 降级，仅保留原子级指针解除，杜绝破坏软链源目标。

### 🧪 单元测试扩充
- 新增 `apps/launcher/src/routes/doctor.test.ts` 路由测试；扩充 `packages/core/src/dsh-heal.test.ts` 安全防穿透测试；全仓 60 项单测 100% 通过。

## [0.5.3] - 2026-09-06

运行优化总方案第一阶段落地：四端安全加固、缺陷清零与现代化路由体系。

### 安全加固
- **静态资源服务路径遍历拦截（P0）**：`serveStatic` 全面接入路径归一化与前缀边界断言，非法越界访问 100% 阻断并返回 403 Forbidden。
- **CORS 白名单端口级收敛（P0）**：废除泛 `http://localhost` 通配符，严格锁定至 5173 / 4780 / 127.0.0.1:4780 与 Tauri 原生协议。

### 缺陷清零与可靠性
- **日志命名对齐与 401 根治（P1）**：全系统统一采用 `dsh-<profile>-<port>.log` 规范，解决服务重启恢复状态丢失 Token 导致的 401 拦截。
- **`runtime.json` 僵尸进程条目治理**：启动阶段主动清理已停止/未监听端口的失效条目，防止元数据文件无限膨胀。
- **PatchManager 语法守护与写前备份（BUG-01）**：写回前自动在 `data/patches-backup/` 留存时间戳副本；调用 `readPatchChecked` 对 `!!js`、`$patch`、嵌套配置进行保护，拒绝盲目覆盖。
- **Vault 自动清洗已物理删除 Profile 的悬空索引（BUG-02）**：`cleanDanglingProfiles` 主动排查并清洗失效索引；`updatePlugin` 增加物理存在性检查并收集细粒度失败报告。
- **`ensureProfilePatches` 损毁配置守护**：支持将 `{}` 空对象及无数组声明的纯注释损毁文件自动重置为合法空数组 `[]\n`。

### UI 交互与工程演进
- **Hash 路由持久化**：全站实现与 `window.location.hash` 实时双向绑定的轻量路由，支持原生前进/后退、书签直达与页面刷新状态保持。
- **死代码清理**：彻底移除未引用的 `apps/shell-web/src/cache.ts` 与废弃样式备份。
- **全量单测扩充**：新增安全守护与悬空索引测试，全仓 53 项单元测试 100% 通过。

## [0.5.2] - 2026-09-06

生产环境精炼、全域下至沙箱、分配页紧凑框选与沙箱自动更新闭环。

## [0.2.6] - 2026-08-29

修复环境无法启动 + 分配页卸载 + 性能优化。

### 修复
- **环境无法启动（根因）**：
  - cordis.patch.yml 序列化对 @ 开头 id 补引号（新版 dsh YAML schema 拒绝裸 @ 值）
  - DSH Desktop junction 断链自愈：启动时从 app.asar 提取官方 bundle 到 %LOCALAPPDATA%\godsh\node_modules 并重建各 profile 依赖（首次约 30s）
  - 启动失败错误诊断：识别配置损坏 / 缺依赖 / Python 模块缺失（灵枢 aeis）/ 端口占用，给出可操作提示
- **插件分配页新增「卸载」**：右键菜单 + 卡片按钮，真正删除环境依赖并同步移除分配

### 性能
- 端口就绪探测 2s 缓存（轮询不再反复 HTTP 请求）+ 启停主动失效
## [0.2.5] - 2026-08-28

市场下载修复 + 批量扩容 + 更新反馈 + 性能优化。

### 修复
- **插件市场下载（根因确认）**：旧版桌面端跨域请求被 CORS 白名单拦截导致市场列表/安装失败，v0.2.5 放行 `tauri.localhost` 等桌面来源；实测 `Access-Control-Allow-Origin` 正确返回。
- **包名匹配**：市场 `name` 与真实 npm 包名（`npm` 字段）不一致的插件（如 `dsh-memory` ↔ `@furongjun1999/dsh-memory`）现在以 npm 字段安装并检测已安装状态。
- **插件市场下载**：安装/更新/卸载加 180s 超时；错误分类提示（网络/包不存在/来源拒绝/依赖冲突/超时）；失败日志落盘 data/logs/plugin-*.log。
- **批量选择**：列表分批渲染（60 + 加载更多），全量 2467 个可浏览；可选/已选计数。

### 新增
- DSH base 更新完成/失败 Toast。

### 性能
- Profile 扫描内存缓存（1s TTL + mtime）+ 写回点主动失效。
- 市场索引本地缓存 7 天。
- 日志轮询 2s→3s、搜索防抖、后台页暂停轮询。
- dsh 版本探测缓存 10s。
# Changelog

## [0.2.4] - 2026-08-28

跨环境插件拖拽（真实鼠标可用）。

### 新增
- **跨环境插件拖拽**：把已分配插件从 A 环境拖到 B 环境（如 plugin_bag → desktop），两个环境的 `cordis.patch.yml` 自动同步写回。
- **拖拽引擎重构为 Pointer Events**：绕开 WebView2 原生 HTML5 拖拽 drop 不触发的问题，真实鼠标/触摸可用。
- **同环境统一列表拖拽排序**：已分配卡片 + 可用插件全部可拖动。
- 可用插件跨环境需目标环境已安装（未安装提示先到市场安装）。

### 修正
- 原生 DnD（draggable/drop）在 WebView2 下 drop 不触发 → 改为自研 Pointer Events 拖拽。

## [0.2.3] - 2026-08-28

插件拖拽全面修复。

### 修正
- dragstart 缺 `setData` 导致 Chromium/WebView2 拖拽不启动 → 统一补 setData。
- 每个环境内「已分配 + 可用插件」统一列表、全部可拖动排序。

## [0.2.2] - 2026-08-27

下一迭代：拖拽全面化 + 市场批量安装/排序 + 性能优化 + 删除增强。

### 新增
- **插件分配拖拽全面化**：每个环境面板新增「可用插件」拖拽区（已安装依赖 + bundles），插件可直接拖到任意环境面板即新建分配（不再依赖输入 ID），保留点选添加。
- **插件市场批量安装**：复选框多选 → 批量安装队列（进度 1/N，逐个显示 等待/安装中/完成/失败+原因）；后端新增 `POST /api/profiles/:name/plugins/batch`（串行、逐包返回结果）。
- **市场排序**：默认 / 🔥 热门（下载量）/ 🆕 最新（时间）。
- **合并轮询**：新增 `GET /api/profiles/status?names=a,b,c`，环境页 3s 轮询一次请求返回全部环境状态。
- **按页代码分割**：7 个页面 `React.lazy` + Suspense，首屏只加载当前页。
- **删除增强**：Profile 卡片 🗑️ 删除按钮（运行中禁用 + Tooltip）；确认框需输入环境名；勾选批量删除需输入 `DELETE`；通用 `ConfirmDialog` 组件。
- 隔离环境冒烟测试 `_smoke-v021.ps1`（17 项检查全过）。


### 修正
- `scripts/bump-version.ps1`：根 package.json 空引用 bug；`Set-Content -Encoding UTF8` 写入 BOM 导致 serde_json 解析失败的问题（改为无 BOM 写回 + 校验）。

### 已知限制
- 桌面应用依赖系统已安装的 `dsh` CLI 与 Node.js。
- GNU 工具链构建要求项目路径不含空格。

## [0.1.0] - 2026-08-26

首个可用版本。

### 新增
- 后端 monorepo（7 个 `@godsh/*` 包）：环境检测、Profile 扫描、进程管理、插件市场封装、内核管理、插件分配、来源校验。
- CLI：`detect / profiles / profile / plugins / market / plugin / start / stop / status / kernels / kernel / allocate / allocations / apply / sync / unallocate / serve / help`。
- HTTP API 服务（默认端口 4780）。
- Web 管理界面（Vite + React + TS，玻璃拟态）：环境、插件市场、插件分配、内核管理四页。
  - 交互：一键启停、状态徽标、拖拽排序、实时日志、右键菜单、快捷键（Ctrl+1..4）。
- Tauri 2 桌面壳：自包含（后端 + 内核模板打进资源），运行时数据存 `%APPDATA%\godsh\data`。
- NSIS 安装器打包。

### 修正
- 真实 DSH 机制：`dsh web` 是 `--profile web` 的硬编码别名，启动任意 Profile 的 Web UI 用 `dsh --profile <name> --port <port> --no-open`。
- **WebView2Loader.dll 缺失导致无法启动**：GNU 工具链下该 DLL 是 WebView 初始化必需项，发布打包（安装器 / ZIP）将其放在 exe 旁；不再使用 Tauri 默认 NSIS 打包（它只把 DLL 放 resources/，导致启动报错）。
- **界面 404**：普通 `cargo build` 会让应用加载 `devUrl`(5173) 而非内嵌前端；发布改用 `tauri build`（`custom-protocol`）内嵌前端（`scripts/make-release.ps1` 已内置）。
- **未发现任何环境**：桌面应用启动时无 `DSH_HOME` 环境变量时兜底到 `~/.dsh`。
- **插件市场中文化**：描述优先 `zh` 字段，新增分类（中文）/星标/下载量展示。

### 已知限制
- 桌面应用依赖系统已安装的 `dsh` CLI 与 Node.js。
- GNU 工具链构建要求项目路径不含空格。
