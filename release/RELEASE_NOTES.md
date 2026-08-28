# godsh v0.2.5

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- `godsh-0.2.5-x64-setup.exe` — Windows 安装器
- `godsh-0.2.5-x64.zip` — 便携版（解压即用）

## v0.2.5 更新

- **插件市场下载修复**：CORS 白名单放行桌面端；安装加超时与错误分类提示；包名匹配修复（`name` ↔ `npm` 字段）
- **批量选择扩容**：2467 个插件全量可浏览，初始 60 + 加载更多
- **更新反馈**：DSH base 更新完成/失败 Toast
- **性能优化**：Profile 扫描缓存、市场索引 7 天本地缓存、轮询降频
- **品牌**：正式更名为 godsh，全新图标

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（`dsh` CLI）与 Node.js ≥ 20
