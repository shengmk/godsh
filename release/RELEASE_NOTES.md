# godsh v0.3.1

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.1-x64-setup.exe — Windows 安装器
- godsh-0.3.1-x64.zip — 便携版（解压即用）

## v0.3.1 更新

- **独立窗口打开 dsh**：「打开」按钮在 godsh 内新建独立窗口加载 dsh 界面（体验与 DSH Desktop 一致）
  - 修复：独立窗口失败时自动改用系统浏览器打开（不再无响应）
  - 右键菜单新增「在系统浏览器打开」备选入口
- **自定义启动端口**：每个环境启动时可指定端口（1-65535），留空自动找空闲端口
- 版本号升级至 0.3.1（0.3.x 系列首个正式版本）
- 包含 v0.2.10 全部修复：环境启动自愈（patch 空文件 / 依赖缓存被清空 / 插件缺 peer 自动诊断）
- 包含 v0.2.9 全部功能：按市场分类自动分配、插件悬停简介、可视化进度、拖动转移

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20