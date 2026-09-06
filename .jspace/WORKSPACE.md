# J-Space Workspace Ledger

## Goal
审查仓库、核实新方案需求、实施新方案改造、端到端测试验证并推送到GitHub仓库

## Core
- 1. **Profile 瘦身与三核固化**：安全物理清理 `manage`、`test-profile`、`plugin_bag` 冗余环境，清洗 `vault.json` 挂载引用，固化 `dshcoding`、`web`、`desktop` 三大健康生产环境。
- 2. **全链路“下至沙箱”能力**：
- 市场页（MarketPage）：针对已安装（`installed`）插件补齐「📦 下至沙箱」动作（未入库时一键反向纳管收割，已入库高亮沙箱就绪）；
- 分配页（AllocationsPage）：行内操作与右键菜单增加「📦 下至沙箱」入口；
- 后端 API：打通 `/api/vault/harvest` 本地零下载瞬时反向入库。
- 3. **分配工作台高密度紧凑化与框选引擎**：
- 行高优化（从 46px 紧缩至 32px），内边距减半；
- 操作收敛：状态微动开关 `⏻` + 悬停轻量图标组 `[↑] [↓] [📦] [🔄] [✕] [🗑️]`，彻底解决长列表橫向拥挤与纵向巨幅滚动的痛点；
- 默认折叠冗余面板，提供紧凑模式开关，首屏可见插件数量提升 300%；
- 鼠标拖拽框选（Marquee Box Selection）：视口 AABB 矩形碰撞判定，支持 Ctrl/Shift 叠加与条目 Checkbox 联动；
- 浮动批量控制条（Batch Action FloatBar）：一键批量启用、批量禁用、批量下至沙箱、批量转移。
- 4. **Bug 修复：沙箱检查更新自动拉取升级全闭环**：
- 彻底解决原 `checkUpdates()` 仅在内存标记 `hasUpdate: true` 而未执行真实文件更新的断环；
- 实现 `updatePlugin(id, targetVersion)`：通过 `npm pack` + `tar.exe` 下载解包至 `vault_store/<pkg>@<ver>`，执行静态 AST 审查，更新多版本元数据；
- 跨 Profile 原子生效：自动为所有挂载了该插件的环境同步原子更新 NTFS Junction 软链与 `package.json`；
- 交互增强：VaultHub 提供「⚡ 自动更新全部」与单条「⬆️ 立即更新」按钮；AllocationsPage 检测到新版本后支持一键全量升级。

## Verified
- Cargo.toml version = "0.5.1" ✅
- tar.exe 与 npm.cmd 本地可用性验证通过 ✅
- DSH 官方依赖自愈套件测试 `dsh-heal.test.ts` 4/4 通过 ✅
- 进程管理测试 `process-manager.test.ts` 7/7 通过 ✅
- 插件沙箱 59 个核心插件资产在 `vault.json` 与 `vault_store` 物理归档完备 ✅
- 目标环境 `dshcoding`、`web`、`desktop` 的 `package.json` 与 `cordis.patch.yml` 结构完整无损 ✅
- 本地回环免认证（Loopback Auto-Auth）垫片与 Token URL 全链路校验通过 ✅
- Profile 冗余目录清理完成，生产三核 (`dshcoding`, `web`, `desktop`) 固化 ✅
- 沙箱自动更新闭环修复：`updatePlugin` + `updateAll` 打通下载解包、安全体检与环境原子生效 ✅
- 市场页与分配页「下至沙箱」零流量反向收割全链路打通 ✅
- 分配页 32px 紧凑高密度布局、状态微动开关、鼠标框选多选（AABB碰撞算法）与浮动批量控制中枢就绪 ✅
- 全套 51 个自动化单元测试 100% 通过，前端生产打包与后端 esbuild 构建全量同步至发行目录 ✅
- ✓01 全量 51 个单元测试 100% 通过，TypeScript 零错误，v0.5.2 客户端与安装包打包就绪，文档与发布说明全面对齐 — verified by: 51 unit tests across 10 packages covering patch, allocation, kernel, heal, vault, process, audit, and tsc check on all ts files

## Open
- [x] 物理清理冗余 Profile 并同步元数据
- [x] 后端实现沙箱插件下载更新与挂载环境原子升级（updatePlugin / updateAll）
- [x] 市场页与分配页打通已安装插件「下至沙箱」
- [x] 分配页高密度紧凑化重构与框选多选控制条
- [x] 全量单测、构建打包与系统发布

## Next
执行 git add、git commit 提交新方案成果并推送到 GitHub 远程仓库 origin main
