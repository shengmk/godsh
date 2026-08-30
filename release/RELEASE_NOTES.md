# godsh v0.2.10

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.2.10-x64-setup.exe — Windows 安装器
- godsh-0.2.10-x64.zip — 便携版（解压即用）

## v0.2.10 更新（环境启动修复）

- **修复「改完插件配置就打不开环境」**：彻底解决两个根因
  - 移除最后一个分配时 patch 文件被写成 0 字节（非法 YAML）→ 现在写合法空数组 `[]`
  - 安装/卸载插件时 pnpm 清空了官方依赖缓存（commander/ws 等）→ 启动前自动检测并补回
- **启动自愈增强**：服务启动与每个环境启动前自动检查 patch 与依赖缓存完整性，坏掉自动修复
- **更清晰的报错提示**：配置损坏 / 依赖缺失 / 插件缺 peer（如 dsh-web-search-pro 需要 dsh-browser）分别给出可操作提示
- 保留 v0.2.9 全部功能：按分类自动分配、悬停简介、可视化进度、拖动转移

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20
