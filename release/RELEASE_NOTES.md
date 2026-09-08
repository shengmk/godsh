# godsh v0.5.5

godsh — DeepSeek Harness 图形化环境配置启动器与环境可靠性中心（Environment Reliability & Control Center）。

## 下载

- **godsh-0.5.5-x64-setup.exe** — Windows 官方安装器（包含完整嵌入式前端、单文件后端与 WebView2 引导）
- **godsh-0.5.5-x64.zip** — 绿色便携版（解压即用）

## 校验和 (SHA256)

请查阅发布资产中的 `SHA256SUMS.txt` 进行完整性校验：
- `godsh-0.5.5-x64-setup.exe`: `1c1dcf3e97df5e2f65e464513a3af6745d0c65f4cc006c4696b2ed7c81a95de4`
- `godsh-0.5.5-x64.zip`: `12373eeba5c29f909b044c205fc85362a3abd07a55cf862074e66ea60d140dda`

---

## ✨ v0.5.5 核心升级：环境可靠性中心与 DSH Desktop 深度兼容

### 🔄 1. 沙箱更新 Bug 根治与环境同步预检
- **Pre-flight 物理连通性与孤立引用清扫**：在 `vault.updatePlugin` 执行前后进行自动环境校验，自动剔除已在外部物理删除的环境残留索引，杜绝无意义重试与静默挂死；
- **颗粒化同步状态反馈**：更新流程支持各环境独立结果跟踪（`updated` / `pruned` / `failed`），并在前端精确反馈更新感知。

### ⏳ 2. 时光机备份与回退系统 (Time Machine Backup & Rollback)
- **多维度快照元数据**：每份快照携带 `SnapshotMeta`（关联 Profile、触发来源、创建时间、文件指纹、保留锁定标记等）；
- **快照生命周期管理**：支持快照防误删锁定（Lock/Unlock）、智能过期淘汰清理（Retention Policy）、存储用量统计；
- **原子级安全回滚**：在执行快照回滚前自动生成安全备份（Safety Snapshot），遇到异常可无损恢复；
- **结构化审计日记**：核心操作（快照、回滚、自愈、修复）自动沉淀至 `godsh-journal.jsonl` 与 `godsh-journal.log`，支持历史审计追溯。

### 🩺 3. 7 阶段自愈工作流引擎 (7-Phase Repair Agent)
- **全自动多阶段自愈流水线**：
  1. `PhaseInspection`：底层依赖校验与环境健康体检；
  2. `PhaseQuarantine`：异常与死链依赖安全隔离；
  3. `PhaseCheckpoint`：自愈前强制生成原子快照；
  4. `PhaseRestore`：环境配置与历史备份重置矫正；
  5. `PhaseDependencyHeal`：核心包与软链自动重建补偿；
  6. `PhaseVerify`：预检验证与启动门禁复测；
  7. `PhaseBootAndReport`：健康验证启动与完整执行报告归档。
- **后台异步化与任务流追踪**：自愈全过程在独立工作流任务中执行，支持实时日志推流与进度查询。

### 🖥️ 4. 系统任务监控中心与实时终端 (`/tasks` & SystemTasksPage)
- **全局任务仪表盘**：统一监控环境自愈、沙箱更新、快照备份、依赖安装等全系统后台异步任务；
- **极客风格终端面板**：内置黑色 Glassmorphism 实时日志终端，支持自动滚动锁定与日志即时高亮；
- **操作审计历史列表**：直观展示历史操作记录、耗时与执行状态，支持日志一键清理与筛选。

### 🚀 5. DSH 官方桌面版 (DSH Desktop) 深度兼容
- **双轨启动通道**：环境列表支持选择使用 Web 版或唤起 DSH 官方桌面版（DSH Desktop）；
- **状态无缝穿透同步**：主动探测并实时同步 `%APPDATA%\DSH Desktop\profile-selection\state.json`，确保桌面版唤起时精准激活对应 profile；
- **Profile Bundle 顺序净化规范**：确保 `@deepseek-ai/dsh-base` 置顶紧随 `@deepseek-ai/dsh-web-app`，彻底剔除已废弃的启动器专属包，保障桌面版稳定运行。

---

## 🧪 自动化测试与质量指标

- 全仓 69 项自动化单元测试 100% 通过（pass 69 / fail 0）；
- TypeScript 类型检查 0 错误；
- Web 前端生产打包 0 警告 0 错误；
- Tauri 桌面端 release 编译成功，输出 NSIS 安装器与独立便携包。

---

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
