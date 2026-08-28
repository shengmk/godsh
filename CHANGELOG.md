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
- 后端 monorepo（7 个 `@dsh-launcher/*` 包）：环境检测、Profile 扫描、进程管理、插件市场封装、内核管理、插件分配、来源校验。
- CLI：`detect / profiles / profile / plugins / market / plugin / start / stop / status / kernels / kernel / allocate / allocations / apply / sync / unallocate / serve / help`。
- HTTP API 服务（默认端口 4780）。
- Web 管理界面（Vite + React + TS，玻璃拟态）：环境、插件市场、插件分配、内核管理四页。
  - 交互：一键启停、状态徽标、拖拽排序、实时日志、右键菜单、快捷键（Ctrl+1..4）。
- Tauri 2 桌面壳：自包含（后端 + 内核模板打进资源），运行时数据存 `%APPDATA%\dsh-launcher\data`。
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
