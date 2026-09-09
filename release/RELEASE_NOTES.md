# godsh v0.6.0

godsh — DeepSeek Harness 图形化环境配置启动器与电影级控制中心（Cinematic Dark & Environment Reliability Center）。

## 下载

- **godsh-0.6.0-x64-setup.exe** — Windows 官方 NSIS 安装器（包含完整嵌入式前端、单文件后端与 WebView2 引导）
- **godsh-0.6.0-x64.zip** — 绿色便携版（解压即用）

## 校验和 (SHA256)

请查阅发布资产中的 `SHA256SUMS.txt` 进行完整性校验：
- `godsh-0.6.0-x64-setup.exe`: `ee59bd032f424a63fb3f84149125dd4352d8d142ee675f9530b81269dea8843a`
- `godsh-0.6.0-x64.zip`: `6441f1e68c9c1860b51e12b0ea6fdce7a7bf5148afe38ccaabe87a921fb7429a`。

---

## 🌟 v0.6.0 重大里程碑升级：全局 UI/UX 电影级翻新与无控制台启动

godsh v0.6.0 是一次视觉品质与用户体验的全面重塑。依托 **UI-UX-Pro-Max 智能设计库**与四大递进阶段，godsh 从一个实用的开发辅助工具彻底升华至具备 **Linear、Raycast 与 macOS 原生质感** 的专业级桌面客户端。

### 🛡️ 1. 彻底消灭黑色命令行启动弹窗 (P0)
- **Win32 进程隐藏启动**：在 Tauri Rust 核心层通过 `CREATE_NO_WINDOW = 0x08000000` 标志注入，彻底消除启动 godsh 时弹出的 `node.exe` / `cmd.exe` 黑色控制台闪烁；
- **全生命周期静默托管**：后端子服务与命令行操作全部转为后台静默管道托管，界面启动如丝般纯粹。

### 🎨 2. 电影级环境底座与设计令牌 (Cinematic Dark & Glassmorphism)
- **防 OLED 拖影纯黑**：全站底座统一采用 `#020203` 纯黑底板，即便在高速滚动下也绝无拖影；
- **现代微光玻璃拟态**：卡片表面采用 `rgba(255,255,255,0.04)` 结合 `backdrop-filter: blur(20px)`，配合 1px 发丝微光边框 `rgba(255,255,255,0.08)`；
- **多层流光点阵图层**：天顶散射微蓝 (`0.14`)、右下极光紫 (`0.09`) 与 24px 网格点阵微光叠加，赋予深邃通透的立体纵深；
- **矢量图标系统全覆盖**：100% 根除所有 Raw Emoji，全量引入 `lucide-react` 精密矢量图标。

### 📊 3. 七大业务功能页面全量看板化
- **ProfilesPage**：环境卡片、运行状态、健康度与双轨启动器（Web 版 / DSH Desktop 官方桌面版）微光一键唤起；
- **AllocationsPage**：32px 超紧凑高密度数据表格、鼠标框选多选（AABB碰撞算法）与悬浮批量控制中枢；
- **VaultHubPage**：沙箱插件网格、版本抽屉、更新自愈检测与反向「下至沙箱」零流量资产归档；
- **SystemTasksPage**：系统任务调度仪表盘与极客风格实时流式控制台终端；
- **MarketPage / ControllerConsolePage / KernelsPage / SettingsPage**：全面统一遵循 Density 8 紧凑看板规范。

### 🧩 4. 实用性防御与键盘无障碍体系
- **空状态光环组件**：虚线微光边框、弥散光环与场景化引导操作；
- **微光渐变骨架屏 (CSS Shimmer)**：平滑流光骨架替换生硬纯文字 Loading；
- **React 错误边界 (ErrorBoundary)**：组件级故障隔离自愈，杜绝白屏崩溃；
- **触控热区与键盘导航**：所有小按钮扩充伪元素热区 `≥ 44×44px`，支持全局 `Esc` 退出模态与 `Ctrl+K` 聚焦搜索；
- **零横向溢出防御**：极端长路径截断与 CSS 弹性容器防护，确保视口严丝合缝。

### ⚡ 5. 阻尼物理按压与极客终端微质感
- **机械按压阻尼**：交互元素引入 `cubic-bezier(0.16, 1, 0.3, 1)` 弹性曲线，`:active { transform: scale(0.975); }` 赋予物理机械轴体按压反馈；
- **全色系状态呼吸灯**：翠绿（运行中）、琥珀（警告/启动）、绯红（异常）与靛蓝（调度）四色动态光晕环；
- **极客终端 CRT 扫描线**：日志面板附加水平交替扫描线微纹理（`pointer-events: none` 绝不拦截划选复制），4px 超细发丝滑轨配合蓝紫荧光；
- **流体弹簧转场**：弹窗与抽屉采用 `@keyframes modal-spring-enter` 180ms 快速回弹展开。

### 🔍 6. 桌面端自动化视觉走查方案
- 联合 **`paicat1/dsh-screenshot`**（Win32 句柄原生截图）与 **`liustack/modlens`**（视觉认知引擎），构建了针对桌面 WebView2 渲染的自动化视觉质检闭环。方案完整收录于文档库 `09_输入文档/方案.md`。

---

## 🧪 自动化测试与工程指标

- **单元测试**：全仓 69 项自动化测试 100% 通过（69 pass / 0 fail）；
- **类型安全**：TypeScript 严格模式 0 错误；
- **前端生产构建**：Vite v5.4.11 编译成功；
- **桌面构建**：Tauri release 输出官方 NSIS 安装包与便携版 ZIP。
