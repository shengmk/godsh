# godsh v0.5.2

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- **godsh-0.5.2-x64-setup.exe** — Windows 官方安装器（包含完整嵌入式前端、单文件后端与 WebView2 引导）
- **godsh-0.5.2-x64.zip** — 绿色便携版（解压即用）

## 校验和 (SHA256)

请查阅发布资产中的 `SHA256SUMS.txt` 进行完整性校验。

---

## ✨ v0.5.2 最新更新（生产环境三核固化、沙箱自动更新闭环、紧凑框选工作台）

### 🛡️ 1. 生产环境瘦身与三核固化 (Profile Convergence)
- **环境安全归档与收敛**：安全清理历史冗余环境（`manage`、`test-profile`、`plugin_bag`），彻底消除磁盘浪费；
- **生产三核基石固化**：标准化固化 `web`（Web 服务端）、`dshcoding`（AI 编程开发态）、`desktop`（桌面原生环境）；
- **元数据残留清洗**：清洗 `vault.json` 中已悬空的废弃环境挂载索引，杜绝断链隐患。

### ⚡ 2. 插件沙箱自动更新全闭环 (Plugin Vault Auto-Update)
- **端到端升级链路**：`updatePlugin` / `updateAll` 打通 npm tgz 物理下载、`tar.exe` 解包入库至 CAS 池、静态安全审查与挂载环境原子同步；
- **多 Profile 原子生效**：更新后自动刷新各 Profile 的 NTFS Junction 软链与 `package.json`，无需重启手动干预；
- **沙箱中枢控制中心 (VaultHubPage)**：新增独立沙箱页面，提供「⚡ 自动更新全部」、版本切换与「🌾 反向收割」操作。

### 📦 3. 全链路已安装插件「下至沙箱」双轨驱动 (Vault Harvest & Offload)
- **零网络反向收割**：打通 `/api/vault/harvest` 接口，支持毫秒级将已存在于环境中的第三方插件直接纳管归档入库；
- **市场页 (MarketPage) 与分配页 (AllocationsPage)**：针对已安装插件直观呈现「📦 下至沙箱」微操作与状态徽标。

### 🎛️ 4. 分配工作台高密度紧凑化与鼠标框选引擎 (Compact & Marquee Selection)
- **32px 超紧凑行高**：行高收敛至 32px，横排长按钮重构为状态微动开关 `⏻` 与悬浮操作胶囊，首屏可见插件数量提升 300%；
- **鼠标拖拽框选 (Marquee Box Selection)**：基于视口 AABB 矩形碰撞检测算法，支持鼠标框选多选、Ctrl/Shift 叠加选择；
- **浮动批量控制中枢**：框选后滑出控制栏，支持批量启用、批量禁用、批量下至沙箱与批量移除。

### 🩺 5. DSH 官方依赖自愈套件 (dsh-heal)
- **P1 单一版本源**：优先提取驱动 CLI 的原生 node_modules 依赖，消除滞后缓存干扰；
- **P2 启动前自检**：硬性校验官方 bundle 完整性与关键包导出项（如 `./model-selection-settings`），拦截启动崩溃并秒级修复。

---

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20

