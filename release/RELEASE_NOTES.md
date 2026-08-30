# godsh v0.3.2

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.2-x64-setup.exe — Windows 安装器
- godsh-0.3.2-x64.zip — 便携版（解压即用）

## v0.3.2 更新

- **DSH Desktop 更新防范**：自动检测 DSH Desktop 升级（app.asar 指纹比对），升级后自动重建官方依赖缓存，避免旧缓存与新版本不兼容导致环境启动失败
- **项目借鉴说明**：README 新增致谢章节，说明本项目借鉴了 [DSH Desktop](https://github.com/dataelement/dsh-desktop)（打开环境 / 官方 bundle 提取）与 [awesome-dsh-plugin（dshmarket）](https://github.com/hackerFish/awesome-dsh-plugin)（插件市场索引）
- **用 DSH Desktop 打开环境**：「打开」按钮优先启动独立的 DSH Desktop 打开对应环境；未安装时自动改用系统浏览器
- 保留 v0.3.1 全部功能：自定义启动端口、分类自动分配、悬停简介、可视化进度、拖动转移、启动自愈

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
