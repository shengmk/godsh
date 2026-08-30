# godsh v0.3.5

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.5-x64-setup.exe — Windows 安装器
- godsh-0.3.5-x64.zip — 便携版（解压即用）

## v0.3.5 更新

- **打开方式重构（更合理）**：
  - 「打开 ↗」默认用**系统浏览器**打开 godsh 启动的 web 界面 —— 与「自定义端口」天然一致（访问的就是你指定的端口），零冲突、最可靠
  - 右键菜单新增「**用 DSH Desktop 打开**」备选（适合 DSH Desktop 未运行时的冷启动场景）
  - 说明：DSH Desktop 常驻运行时（单实例锁）新进程的 profile 环境变量不生效，会显示它原来的界面，因此不再作为默认打开方式
- 保留全部既有功能：发布年龄自动修复、启动自愈、分类自动分配、自定义端口、悬停简介、可视化进度

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
