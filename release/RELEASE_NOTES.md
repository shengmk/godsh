# godsh v0.3.4

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- godsh-0.3.4-x64-setup.exe — Windows 安装器
- godsh-0.3.4-x64.zip — 便携版（解压即用）

## v0.3.4 更新

- **插件下载失败自动修复**：遇到「发布年龄限制」（pnpm 11 拒绝安装发布不足 1 天的插件，报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）时：
  - 自动在对应环境的配置中关闭该限制并重试安装（单装 / 批量安装均支持）
  - 仍失败时给出明确中文原因提示（「发布年龄限制」），不再只显示模糊的依赖错误
- 延续 v0.3.3：新环境默认关闭发布年龄限制，已有环境启动时自动补齐
- 保留全部既有功能：DSH Desktop 打开环境、启动自愈、分类自动分配、自定义端口、悬停简介、可视化进度

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20