# godsh v0.5.4

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- **godsh-0.5.4-x64-setup.exe** — Windows 官方安装器（包含完整嵌入式前端、单文件后端与 WebView2 引导）
- **godsh-0.5.4-x64.zip** — 绿色便携版（解压即用）

## 校验和 (SHA256)

请查阅发布资产中的 `SHA256SUMS.txt` 进行完整性校验。

---

## ✨ v0.5.4 最新更新（全维环境体检引擎、启动预检门禁、重解析点穿透隔离防御与自愈闭环）

### 🩺 1. 全维环境体检引擎落地 (godsh doctor & /api/doctor/*)
- **原生 TypeScript 六层体检流水线**：
  - **Layer 0 (全局 CLI)**：检测 DSH 全局安装状态、CLI 核心包导出与运行时版本匹配度；
  - **Layer 1 (网络监听)**：精确对齐系统网络端口占用与真实存活 PID，清理失效进程条目；
  - **Layer 2 (HTTP 状态)**：主动探测 Web 端口心跳与接口连通性；
  - **Layer 3 (配置与占位符)**：深度扫描识别破损占位符死链与非法残存空包；
  - **Layer 4 (Patch 状态)**：深层校验 `cordis.patch.yml` 语法合规性，保障用户自定义配置安全；
  - **Layer 5 (Junction 软链状态)**：扫描死软链，过滤 `.bin`/`.pnpm` 目录误报，排查直连宿主 CLI 跨目录风险。
- **CLI 与 RESTful API 双向赋能**：新增 `godsh doctor [profile] [--fix]` 命令行；暴露 `/api/doctor/diagnose`、`/api/doctor/preflight`、`/api/doctor/heal`、`/api/doctor/safe-clean` 服务端点。

### ⚡ 2. 毫秒级启动预检门禁 (Pre-flight Gatekeeper)
- **前置阻断闪退**：在环境启动 (`POST /api/profiles/:name/start`) 阶段注入毫秒级门禁；遇占位符死链或致命依赖缺失前置拦截并返回结构化 `preflightBlocked` 诊断信息，告别盲目启动闪退。

### 🛡️ 3. P0/P1 重解析点穿透隔离防御 (Anti-Penetration Junction Purge)
- **重置隔离安全栅栏（P0 根治）**：在重置 Profile 目录前强制注入 `safePurgeProfileJunctions`，先剥离全部 Junction 再清空物理文件，彻底阻断顺着 Junction 穿透回杀宿主全局 CLI 的 95 个核心依赖包。
- **环境删除隔离屏障（P0 根治）**：在 `removeProfile` 中清除环境物理目录前彻底剥离重解析指针，杜绝环境删除反噬全局环境。
- **废除解绑递归降级（P1 根治）**：在 `safeUnlinkJunction` 中彻底废除 `rmSync(..., { recursive: true })` 降级，仅保留原子级指针解除，杜绝破坏软链源目标。

### 🧪 4. 自动化测试全量扩充
- 新增 `apps/launcher/src/routes/doctor.test.ts` 路由测试套件；
- 扩充 `packages/core/src/dsh-heal.test.ts` 安全防穿透与占位符门禁拦截用例；
- 全仓 60 项自动化单元测试 100% 通过（pass 60 / fail 0），TypeScript 类型检查 0 错误。

---

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20


