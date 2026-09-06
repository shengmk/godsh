# godsh v0.5.3

godsh — DeepSeek Harness 图形化环境配置启动器（Anaconda Navigator 类比）。

## 下载

- **godsh-0.5.3-x64-setup.exe** — Windows 官方安装器（包含完整嵌入式前端、单文件后端与 WebView2 引导）
- **godsh-0.5.3-x64.zip** — 绿色便携版（解压即用）

## 校验和 (SHA256)

请查阅发布资产中的 `SHA256SUMS.txt` 进行完整性校验。

---

## ✨ v0.5.3 最新更新（运行优化总方案第一阶段、四端安全防御加固与缺陷清零）

### 🛡️ 1. 静态资源路径遍历渗透防御（P0 漏洞拦截）
- **路径归一化与前缀断言**：`serveStatic` 全面接入 `path.normalize` 与首部 `..` 剥离，并在进入文件系统前断言目标路径必须位于 `distDir` 根目录下，任何逃逸尝试即刻拦截并响应 `403 Forbidden`。

### 🔒 2. CORS 白名单收敛至本地端口（P0 漏洞治理）
- **废除泛通配符**：废除开放的 `http://localhost` 泛通配配置，严格锁定至 `5173`（前端开发态）、`4780`、`127.0.0.1:4780` 与 Tauri 协议，杜绝本地跨源嗅探漏洞。

### ⚡ 3. 统一日志命名彻底根除重启 401（P1 缺陷根治）
- **前后端文件规范对齐**：全系统对齐采用 `dsh-<profile>-<port>.log` 规范，解决重启服务状态恢复时无法提取 Token 导致的 401 拦截，Token 注入恢复成功率提升至 100%。

### 🧹 4. 运行时僵尸进程条目自愈与清洗
- **runtime.json 膨胀治理**：启动阶段主动对齐系统网络端口，实时清洗已停止或崩溃的失效 entry，防止元数据文件随时间无限累积膨胀。

### 🛡️ 5. PatchManager 高级 YAML 语法守护与写前自动备份（BUG-01 根治）
- **拒绝破坏性盲写**：在 `enablePlugin` / `disablePlugin` 写入前全面调用 `readPatchChecked` 校验门禁，若遇到 `!!js` 动态表达式、嵌套对象或 `$patch` 规则等不可安全逆向语法时拒绝盲目覆盖破坏；
- **写前自动备份**：修改前自动在 `data/patches-backup/` 留存时间戳副本，保障用户手动配置绝对安全。

### 🌾 6. Vault 自动清理物理失效 Profile 悬空索引（BUG-02 根治）
- **主动排查与自动清洗**：新增 `cleanDanglingProfiles` 与对应 API，自动扫描并清除已物理删除 Profile 在沙箱中的废弃引用；
- **同步升级状态透明**：`updatePlugin` 遍历挂载环境时严格校验环境目录存在性，并透出细粒度部署结果，不再静默吞错。

### 🧭 7. UI 全站 Hash 路由持久化与工程死代码清理
- **Hash 路由与浏览器历史**：全站实现与 `window.location.hash` 实时双向绑定的轻量路由体系，支持浏览器前进/后退、标签页直达与刷新状态保持；
- **工程去冗余**：彻底移除未引用的 `apps/shell-web/src/cache.ts` 与废弃样式备份；
- **测试覆盖扩充**：新增安全守护与悬空清理专项单测，全仓 53 项单元测试 100% 通过。

---

## 环境要求

- Windows 10 / 11（需 WebView2 运行时，Windows 11 自带）
- 已安装 DeepSeek Harness（dsh CLI）与 Node.js ≥ 20


