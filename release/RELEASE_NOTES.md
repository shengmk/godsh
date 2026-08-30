# godsh v0.3.3

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.3-x64-setup.exe — Windows 安装器
- godsh-0.3.3-x64.zip — 便携版（解压即用）

## v0.3.3 更新

- **修复「插件下载失败」**：市场里能搜到的插件某些环境装不上（如 web 装 dsh-agy-link 报依赖错误）
  - **根因**：pnpm 11 内置供应链安全策略 `minimumReleaseAge`（默认 1440 分钟 = 1 天），新发布/刚更新的插件会被拒绝安装
  - **修复**：所有环境自动写入 `minimumReleaseAge: 0` 关闭该限制，新插件立即可装；已有环境启动时自动补齐
  - 新增 3 个单元测试防回归
- **用 DSH Desktop 打开环境**：「打开」按钮优先启动独立的 DSH Desktop；未安装时自动用系统浏览器
- **DSH Desktop 更新防范**：自动检测升级并重建依赖缓存
- 保留全部既有功能：自定义启动端口、分类自动分配、悬停简介、可视化进度、拖动转移、启动自愈

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
