# godsh v0.3.6

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.6-x64-setup.exe — Windows 安装器
- godsh-0.3.6-x64.zip — 便携版（解压即用）

## v0.3.6 更新

- **「打开」改用浏览器网址应用化**：「打开 ↗」现在用系统浏览器（Edge/Chrome）的 `--app=URL` 模式打开 dsh web 界面 ——
  - **独立应用窗口**（无地址栏、独立任务栏图标，体验接近桌面应用）
  - **浏览器渲染，不会白屏**（解决之前 godsh 内嵌窗口白屏问题）
  - 访问的正是你**自定义端口**上的 web 服务，零冲突
- 右键菜单保留：「用 DSH Desktop 打开」（冷启动场景）、「在系统浏览器打开」
- 保留全部既有功能：发布年龄自动修复、启动自愈、分类自动分配、自定义端口、悬停简介、可视化进度

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
