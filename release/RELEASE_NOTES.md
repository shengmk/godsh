# godsh v0.2.6

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.2.6-x64-setup.exe — Windows 安装器
- godsh-0.2.6-x64.zip — 便携版（解压即用）

## v0.2.6 更新

- **修复环境无法启动**：
  - patch 序列化补引号（@ 开头 id 不再被 YAML 解析拒绝）
  - 启动自愈：DSH Desktop junction 断链自动提取官方 bundle 并重建（首次约 30s，之后毫秒级）
  - 启动失败给出可操作诊断（配置损坏 / 缺依赖 / Python 模块缺失 / 端口占用）
- **插件分配页新增「卸载」**：真正从环境删除插件依赖（不再只是移除分配）
- **性能优化**：端口就绪探测加 2s 缓存，轮询不再反复发 HTTP 请求
- **品牌**：godsh（版本 0.2.6）

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20