# Release Notes — dsh Launcher v0.2.1

dsh 环境配置启动器（Anaconda Navigator 类比）—— 在 v0.2.0 基础上修复版本显示并新增 dsh 全删除。

## 下载

| 文件 | 说明 |
| --- | --- |
| `dsh-launcher-0.2.1-x64-setup.exe` | Windows 安装器（NSIS，安装到 `%LOCALAPPDATA%\dsh-launcher`） |
| `dsh-launcher-0.2.1-x64.zip` | 便携版（解压后双击 `dsh-launcher.exe` 即可） |

校验和见同目录 `SHA256SUMS.txt`。

## v0.2.1 修复与新增

- **dsh 版本显示修复（自愈）**：重置/首启后自动重新注册 base 环境，控制台/顶栏/DSH 环境页统一显示"当前实际使用版本 + 检测数量 + 最新版提示"。
- **并列环境版本下拉**：从 npm 已发布版本列表中选择（不再手输）。
- **重置新增「dsh 全删除」**：卸载全局 dsh + 删除整个 DSH_HOME + 删除并列环境 + 清空数据（需输入 DELETE 强确认）。
- 检测与 npm 查询加缓存（提速、避免轮询拖慢）。
- 新增 5 份审计文档（docs/audit/）：可行性 / 可迁移性 / 安全性 / 卸载项目检查 / 项目所有过程保留备份。

## v0.2.0 主要功能（回顾）

控制台主页一键快速启动默认模板；DSH 环境管理（base 主环境 + 并列环境添加/删除/激活，类比 Anaconda）；无 dsh 自动安装成 base；环境新建/删除；插件卸载/更新；dsh 全部清空（范围自选）；卸载 Launcher；版本显示准确化。

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（`dsh` CLI）与 Node.js ≥ 20
- 桌面应用启动时会自动拉起内置 Node API 后端（端口 4780）

## 使用

详见 [`QUICKSTART.md`](../QUICKSTART.md)、[`使用说明.md`](../使用说明.md) 与 `docs/audit/` 下的检查文档。

## 已知限制

- 桌面应用依赖系统已安装的 Node.js（后端以 Node 子进程方式运行）
- GNU 工具链构建要求项目路径不含空格（见迭代日志）
- 并列环境首次安装需全量下载 dsh 依赖（受网络与 npm 缓存影响，界面显示进度日志）
- 卸载程序不删除运行时数据目录（`%APPDATA%\dsh-launcher\data`），如需彻底清除请先「重置」或手动删除
