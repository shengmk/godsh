# J-Space Workspace Ledger

## Goal
godsh v0.5.1 正式发布：插件仓库沙箱中枢、市场暂存、DSH 环境页刷新+日志框、动态安全端口、NSIS+ZIP 发布到 GitHub Release

## Core
- 7 页导航（console/profiles/market/allocations/kernels/dsh-envs/settings）+ KeepAlive + 按页代码分割
- Vault 沙箱：addFromMarket / importLocal / deployToProfile / remove / checkUpdates（后端完整）
- 动态安全端口 findFreePort（跳过已运行环境端口；多环境并行运行）
- DSH 环境页：持久日志框 + 🔄 刷新（清缓存重探测）+ 任务 Toast

## Verified
- Cargo.toml version = "0.5.1" ✅
- release/ 产物时间戳 2026-09-04 00:29–00:31（真正全量编译，非旧版复用）✅
- GitHub Release 单一 v0.5.1 条目，旧重复条目已删除 ✅
- 全部 45 项功能点代码审计通过 ✅（见 brain/v051_feature_audit.md）

## Open
- W-01: lib.rs L177 后端端口 4780 写死 → 若端口冲突则无法启动，建议改为动态探测后传给 Node
- W-04: DashboardPage.tsx 存在但未在 NAV 注册 → 确认是否死代码
- W-05: Vault API 完整（6 个端点）但前端无独立 Vault 管理页面（列表/部署/删除均无入口）

## Next
- 修复 W-01：Tauri 启动时动态选空闲端口，通过环境变量传给 server.mjs
- 实现 W-05：新增「仓库」页或在 AllocationsPage 中嵌入 Vault 面板（展示暂存列表、一键部署）
- 清理 styles.css.bak-04 + DashboardPage.tsx 死代码
