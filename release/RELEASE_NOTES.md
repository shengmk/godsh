# godsh v0.2.6

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.2.6-x64-setup.exe — Windows 安装器
- godsh-0.2.6-x64.zip — 便携版（解压即用）

## v0.2.6 更新

- **修复环境无法启动（完整解决）**：
  - 清理 patch 中残留的官方 bundle id（由 bundles 机制加载，写在 patch 里会导致 loader 崩溃）
  - patch 序列化对 @ 开头 id 补引号（新版 dsh YAML schema 拒绝裸值）
  - DSH junction 断链自愈：从 app.asar 提取官方 bundle（含 sharp/koffi 原生二进制）并重建各 profile 依赖
  - 启动失败给出可操作诊断（配置损坏 / 缺依赖 / Python 模块缺失 / 端口占用）
- **多环境可同时运行**：端口自动分配（web=3080 / plugin_bag=3081 / desktop=3082），启动串行队列避免并发冲突
- **插件分配页新增「卸载」**：真正删除环境依赖并同步移除分配；官方内核 bundle 提示不可卸载；包名不匹配时自动匹配重试
- **性能优化**：端口就绪探测 2s 缓存
- **品牌**：godsh（版本 0.2.6）

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20