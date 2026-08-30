# godsh 项目完整信息交接文档（v0.3.1）

> 本文件是 **godsh** 项目的最新完整信息,供下一个 AI 编程会话作为输入,不依赖旧会话记忆即可理解项目全貌。
> 生成时间:2026-08-30(基于 git 最新提交 68e0a8a,已推送 origin/main,仓库干净)。

---

## 0. 一句话概括

**godsh**(曾用名 "dsh Launcher")是 DeepSeek Harness(dsh)的图形化环境配置启动器(类比 Anaconda Navigator):管理 DSH 的 Profile(环境)、插件分配/安装、Web 内核与 DSH 本体版本;Windows 桌面(Tauri 2)+ Web 双形态。

**当前版本:v0.3.1**(0.3.x 系列首个正式版),已发布 GitHub Release(4 资产齐全,旧版本全部保留)。

---

## 1. 项目目的与类比

| Anaconda | DSH | godsh |
| --- | --- | --- |
| Anaconda Navigator | dsh web / CLI | 本启动器 |
| conda | dsh CLI | 启动器底层调用 |
| Python | DeepSeek Harness 核心 | dsh 本体 |
| conda env | DSH Profile | 环境管理 |
| pip/conda 包 | dsh plugin / bundle | 插件分配与安装 |
| conda channel | dshmarket / awesome-dsh-plugin | 插件市场 |

**核心价值**:把 dsh 的命令行操作(环境启停、插件安装/分配、版本管理)变成可视化、拖拽化、一键化;让没有 dsh-web-app 的 Profile 也能启动出 Web UI(统一内核)。

---

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js ≥ 20 · TypeScript ESM · 纯 `node:http`(零框架)· esbuild 单文件 `server.mjs`(~160KB) |
| 前端 | Vite 5 · React 18 · TS · 玻璃拟态 CSS(浅色+深色)· `React.lazy` 按页分包(8 页独立 chunk) |
| 桌面 | Tauri 2(Rust,`crate-type=["rlib"]`,GNU/MinGW 工具链)+ WebView2 · 自包含(后端+模板打进资源) |
| 安装 | 自定义 NSIS(exe 旁放 WebView2Loader.dll)+ 便携 ZIP |
| 测试 | `node:test` 单元测试(20 用例)+ 手动冒烟回归 |
| 包管理 | pnpm workspace monorepo(ESM + `moduleResolution: Bundler`) |

---

## 3. 目录结构

```text
C:\Users\Shengmingkai\Desktop\dsh__launcher\dsh-launcher-project-0.2.2\   ← 工作区(目录名过时,代码已是 v0.3.1)
├─ apps/
│  ├─ launcher/            # 主应用:CLI + HTTP API + Tauri 桌面壳
│  │  ├─ src/
│  │  │  ├─ cli.ts         # CLI 入口(detect/profiles/start/.../serve)
│  │  │  ├─ context.ts     # 共享上下文(manager 装配)
│  │  │  ├─ server.ts      # HTTP API 装配器(路由分派+静态服务+启动自愈)
│  │  │  └─ routes/        # 按资源域拆分的 API 路由(9 个文件)
│  │  └─ src-tauri/        # Tauri 桌面壳(lib.rs 拉起后端 + resources)
│  └─ shell-web/           # Web 管理界面(src/pages/ 8 页 + api.ts + types.ts + styles.css)
├─ packages/               # 8 个业务包(全部 v0.3.1)
│  ├─ core/                # 环境检测、进程管理、配置存储、路径、run、dsh-heal(自愈)
│  ├─ profile-manager/     # Profile 扫描/创建/删除 + cordis.patch.yml 解析/序列化
│  ├─ plugin-registry/     # bundle/client 插件识别
│  ├─ allocation/          # 插件分配(含 patch 写回守护 + 备份 + 官方 bundle 过滤)
│  ├─ kernel-manager/      # 内核模板/实例 + 统一内核(bundle 注入 + 按环境覆盖)
│  ├─ marketplace/         # `dsh plugin` 封装(代理/store-dir/git-https 注入)+ 市场索引缓存
│  ├─ dsh-env/             # DSH 本体环境(base/managed/external)
│  └─ security/            # 来源校验、构建授权
├─ scripts/                # bump-version / make-release / update-release.js / verify-release.mjs / build-tauri / dev / smoke
├─ docs/                   # 发布到GitHub指南.md、程序0.2.6升级优化.md
├─ kernels/templates/      # 内核模板
├─ release/                # 发布产物(0.2.8/0.2.9/0.2.10/0.3.1 各版本 setup+zip+source+SHA256)
├─ data/                   # 运行时数据(gitignore)
└─ .github/workflows/      # GitHub Actions 自动打包(release.yml)
```

**重要备份位置**:`C:\Users\Shengmingkai\Desktop\dsh__launcher\godsh-内部文档备份\docs\`(21 个文件,含 `为下一个AI编程对话的资料和输入.md`(v0.2.4 时代)、`iteration-log.md`、`进度.md` 等历史文档,用户要求保留)

---

## 4. 当前功能全景(v0.3.1 全部可用)

### 4.1 八页导航
控制台 / 环境 / 插件市场 / 插件分配 / 内核管理 / DSH 环境 / 设置 + 启动加载画面(可爱风格 splash,≥1.8s,并行预热)。

### 4.2 环境(Profile)管理
- 扫描/新建/删除/启停;运行状态徽标(运行中/启动中/已停止/启动失败)
- 合并轮询 `GET /api/profiles/status?names=a,b,c`(3s 一次请求返回全部)
- 批量启停;每环境指定 dsh 版本下拉;端口占用视图(`GET /api/ports`)
- **启动失败诊断** `diagnoseStartFailure`:按日志关键字分类(YAML 损坏/依赖缺失/Python 模块缺失/端口占用/loader 错误),给出可操作中文提示
- **启动串行队列** `enqueueStart`:多环境同时启动逐个执行,防 junction 竞争

### 4.3 插件市场
- 搜索(防抖)、中文描述优先、分类/星标/下载量、排序
- 单装/更新/卸载 + 批量安装队列(串行、逐包结果)+ **每环境全部更新**(后台任务+进度面板轮询)
- 市场索引:https://awesome-dsh-plugin.com/plugins.json(约 2656 个插件,字段:name/owner/url/category/description{zh,en}/npm/tarball/stars/downloads/install/added/screenshots)
- **22 个官方分类**:agi/ui/usage/theme/model/identity/session/memory/tools/browser/vision/voice/docs/skill/workflow/git/notify/dev/security/remote/market/fun

### 4.4 插件分配(v0.2.9+ 大幅增强)
- **按市场分类分组**:每个环境"可添加"插件按 dshmarket 22 分类分组显示,组头「⚡ 全部分配」按钮(一键批量分配,写回 patch,幂等+回滚守护)
- 每行悬停显示插件简介/版本/来源 tooltip(350ms 延迟)
- **点击即分配**:可用插件单击即分配到本环境(拖动仍支持)
- **跨环境拖动 = 剪切并复制**:`POST /api/allocations/move-with-install`,目标环境未安装自动安装(`dsh plugin add`),再从源环境移除分配
- 同环境拖动排序;启用/禁用;上移/下移;移除分配;卸载(智能:依赖→pnpm remove,纯 bundle→从 bundles 移除);dsh-base 受保护
- 拖拽引擎:自研 Pointer Events(WebView2 原生 DnD drop 不稳定,已弃用)

### 4.5 统一内核
- 把 `@deepseek-ai/dsh-web-app` + 用户偏好插件注入 Profile 的 `dsh.profile.bundles`(不是 `--patch`,实测缺 webServer 服务启动失败)
- 按环境覆盖(跟随全局/强制注入/跳过注入);只移除本工具添加的条目

### 4.6 DSH 环境 / 设置
- base 主环境 + 并列环境(npm --prefix 受管)+ 外部检测;版本自愈注册
- 主题(浅/深/跟随系统)、语言(中/英)、路径、市场 URL、数据备份/恢复、重置、卸载

---

## 5. 关键技术机制(必须理解的 DSH 真实事实)

1. **`dsh web` 是 `--profile web` 的硬编码别名**,不接受 `--profile`。启动任意 Profile 的 Web UI 正确命令:`dsh --profile <name> --port <port> --no-open`(无 `web` 字样)。
2. **统一内核用 bundle 注入而非 `--patch`**:Web 表面由 dsh-web-app bundle 自带的 cordis.patch.yml 提供,`--patch` 只插行会因缺 webServer 服务启动失败。
3. **Windows shim/pid 陷阱**:`dsh` 走 cmd shim,pid 文件记录 shim pid;API 重启后 shim 已退出、真实 dsh(node)被孤儿化但仍监听端口 → 用 `findPidByPort`(netstat 反查)判活/停止。
4. **CORS 白名单**:默认允许 `http://tauri.localhost` / `tauri://localhost` / `http://localhost`(桌面端跨域访问 127.0.0.1:4780 必需);`corsHeaders` 按请求 Origin 精确匹配回显。
5. **patch 写回守护**:`readPatchChecked` 拒绝含嵌套配置/`!!js`/`$patch` 的不可解析结构;写回前备份到 `data/patches-backup/`;分配写回失败回滚 + 409。
6. **dsh 命令解析**:`resolveDshCommand()` 优先 `%APPDATA%\npm\dsh.cmd`(npm 全局);**PATH 里第一个 dsh 是 DSH Desktop 的 shim**(`%APPDATA%\DSH Desktop\host-commands\desktop\bin\dsh.cmd`),它用 DSH Desktop.exe + asar 内置 dsh——启动 Profile 必须绕开它或用 npm 全局 dsh。
7. **官方 bundle 自愈**(dsh-heal.ts):
   - `extractAsarNodeModules`:把 DSH Desktop 的 `app.asar` 内 node_modules 全量提取到 `%LOCALAPPDATA%\godsh\node_modules`(unpacked 原生二进制从 `app.asar.unpacked` 复制),`.complete` 标记防重复提取,首次约 24s/117MB
   - `healProfilesNodeModules`:每个 profile 的 node_modules 建 junction 指向缓存(@deepseek-ai 全包 + 顶层依赖包)
   - `prepDshFallback`:预建 `profiles/node_modules/@deepseek-ai/*` 指向 asar 路径的 junction,dsh 自己的 heal 检查一致即跳过
   - `ensureCacheIntegrity`(v0.2.10 新增):扫描缓存空目录包,从 asar 补回
8. **pnpm 供应链陷阱**:
   - `pnpm-workspace.yaml` 必须有 `packages: [.]` 隔离 workspace(否则 pnpm 向上遍历到用户主目录,触发 supply-chain 拒绝新包)
   - `allowBuilds` 需显式 true(node-pty/ssh2/cpu-features/esbuild/sharp/koffi 等);pnpm 11 自动写占位符 "set this to true or false" 必须改 true
   - git-hosted 包需 `pkg@URL: true` 且 URL 含 `:` 要引号包裹(与 `quoteIdIfNeeded` 同类问题)
   - github: 源默认转 git+ssh 会失败 → 注入 `GIT_CONFIG_COUNT/KEY_0/VALUE_0` + `GIT_TERMINAL_PROMPT=0` 强制 HTTPS
   - 统一 store:`npm_config_store_dir=%LOCALAPPDATA%\pnpm\store`(防多版本 pnpm store 冲突)
   - 代理:`detectLocalProxy()` 查环境变量 + netstat 常见端口[7890,7897,10809,10808,1080,12450,8888],curl 验证能访问 github 才注入
9. **市场安装参数解析** `resolveInstallArg(p)`:npm 字段 → install 命令文本提取 `add <arg>` → github:/URL 正则 → name 去 `#` 后缀。前端传 `marketName`,后端解析真实安装参数。
10. **运行状态持久化**:`runtime.json`(pidDir 下)记录 profile→port,API 重启后按端口反查恢复"仍在运行"。

---

## 6. v0.2.10 关键修复(改配置后环境打不开的三层根因)

用户痛点:**每次修改环境插件配置后,该环境启动失败**。三层根因:

1. **patch 文件被写空**(直接原因):`serializePatchList([])` 旧实现返回空字符串 → 移除最后一个分配时 `cordis.patch.yml` 被写成 **0 字节空文件** → dsh 解析失败。
   - 修复:`serializePatchList([])` 返回合法 `'[]\n'`;新增 `ensureProfilePatches`(server 启动时把 0 字节/纯空白 patch 恢复为 `[]`)
2. **pnpm 清空官方依赖缓存**(启动失败真凶):profile 的 node_modules 顶层依赖(commander/ws/node-pty 等)是 junction 指向提取缓存;pnpm 安装插件时把 junction 目标当"孤儿依赖"清空 → dsh 下次启动 `Cannot find package '...\godsh\node_modules\commander\index.js'`。
   - 修复:新增 `ensureCacheIntegrity()`(server 启动 + profile start 前扫描空目录包,从 asar 补回);手动全量重提取缓存一次
3. **插件缺 peer 依赖**:web 环境的 dsh-web-search-pro peer 依赖 `@anweat/dsh-browser`,未装 → dsh 严格模式 `1 entry did not activate: pending (waiting for service: browser)`。
   - 修复:手动 `dsh plugin --profile web add @anweat/dsh-browser`(自动加入 dependencies+bundles);诊断提示已覆盖该类错误

**未来避免**:三类问题均已自动自愈 + 明确诊断提示,无需手动处理。

---

## 7. 工程现状

- **git**:分支 `main`,已推送,工作区干净;tag 有 v0.2.5/v0.2.6/v0.2.7/v0.2.8/v0.2.9/v0.2.10/v0.3.1
- **GitHub**:仓库 `shengmk/godsh`;Release 保留全部旧版本(用户要求永不删除)
- **测试**:`pnpm test`(20 单测:patch/allocation/unified-kernel),`pnpm typecheck` 全量类型检查
- **验证模式**:typecheck → test → build:server → vite build → 起测试服务(新端口)端到端验证

---

## 8. 构建与发布命令(完整流程)

```powershell
# 日常验证
pnpm typecheck        # 全量类型检查
pnpm test             # 单元测试(20)
pnpm build:server     # esbuild → apps/launcher/dist/server.mjs
pnpm --filter @godsh/shell-web exec vite build   # 前端(开发模式)
pnpm --filter @godsh/shell-web build:tauri       # 前端(tauri 模式,API 指向 4780)

# 版本升级(自动同步全部 package.json / Cargo.toml / tauri.conf.json / config.json / config-store.ts)
powershell -File scripts/bump-version.ps1 -Version 0.3.2

# 发布打包(build:server → build:web(tauri) → tauri build 内嵌前端 → NSIS + ZIP + SHA256)
powershell -File scripts/make-release.ps1 -Version 0.3.2

# GitHub Release(创建/更新 body + 上传资产,Node fetch UTF-8 安全)
node scripts/update-release.js 0.3.2 --body release/RELEASE_NOTES.md --upload release
node scripts/verify-release.mjs 0.3.2   # 验证 Release 状态

# git 推送(github.com 直连常被墙,用系统代理 127.0.0.1:12450)
git config http.proxy http://127.0.0.1:12450   # 推完记得 unset
git push origin main
git tag v0.3.2 && git push origin v0.3.2
```

**发布全流程(每个新版本)**:
1. 更新 `release/RELEASE_NOTES.md`(中文,含下载说明+更新内容)
2. `bump-version.ps1 -Version X`
3. `make-release.ps1 -Version X`(内部复制到 `%USERPROFILE%\godsh` 无空格目录,tarui GNU 工具链)
4. git commit(空消息 `-m ' '`)+ push(代理)+ tag + push tag
5. `git archive --format=zip -o release/godsh-X-github-source.zip vX`(源码包)
6. 建 GitHub Release(必须用 **Node fetch**,PowerShell Invoke-RestMethod 会把中文变 `?`)+ `update-release.js` 上传 4 资产
7. `verify-release.mjs X` 验证(中文完好、资产齐全)

> **GNU 工具链限制**:构建要求项目路径不含空格(make-release.ps1 内部复制到 `%USERPROFILE%\godsh`)。

---

## 9. 环境与工具事实(本机)

| 项 | 值 |
| --- | --- |
| 项目工作区 | `C:\Users\Shengmingkai\Desktop\dsh__launcher\dsh-launcher-project-0.2.2`(目录名过时,代码 v0.3.1) |
| 构建目录 | `%USERPROFILE%\godsh`(make-release 内部用,无空格) |
| DSH Desktop | `C:\Users\Shengmingkai\AppData\Local\Programs\DSH Desktop\`(v2.0.3,asar 提取源) |
| npm 全局 dsh | `%APPDATA%\npm\dsh.cmd` → `node_modules\@deepseek-ai\dsh\lib\bin.js`(v0.1.1-rc.2) |
| DSH Desktop shim | `%APPDATA%\DSH Desktop\host-commands\desktop\bin\dsh.cmd`(PATH 第一位,勿用于启动 Profile) |
| DSH_HOME | `C:\Users\Shengmingkai\.dsh`(profiles 目录:`C:\Users\Shengmingkai\.dsh\profiles`) |
| 数据目录(桌面版) | `%APPDATA%\godsh\data`(allocations.json/config.json/dsh-envs.json/logs/cache) |
| 提取缓存 | `%LOCALAPPDATA%\godsh\node_modules`(官方依赖 junction 目标) |
| 测试 API 端口 | 桌面 4780;测试可另起新端口(4790+) |
| 用户 profile | web / desktop / plugin_bag(web 是主要环境) |
| 市场索引 | https://awesome-dsh-plugin.com/plugins.json(约 2656 插件,22 分类) |
| npm 镜像 | https://registry.npmmirror.com(部分安装失败时可用) |
| 代理 | 系统代理 127.0.0.1:12450(Clash);git push 需临时配置 |
| pnpm | v11.22(npm 全局)/ v11.8(DSH 内置);统一 store `%LOCALAPPDATA%\pnpm\store` |
| Node | `C:\Program Files\nodejs\node.exe`(v25.8.0) |

---

## 10. 用户偏好与工作规范(必须遵守)

1. **所有旧版本 Release 永不删除**(用户明确要求"release 界面可以同时有旧版本")
2. **git commit 用空消息**(`git commit --allow-empty-message -m ' '`),保持 GitHub 文件列表干净
3. **所有文档保留**(本地备份 `godsh-内部文档备份\docs\` 存在;不要删除工作区根历史 md)
4. **界面中文**;所有 GitHub Release body / 描述更新必须用 **Node fetch UTF-8**(PowerShell 会损坏中文为 `?`)
5. 不直接改 DSH 源码;通过 CLI 和文件配置驱动
6. 不手工改 node_modules;插件安装/卸载走 `dsh plugin` 或 pnpm
7. 插件分配最终落到 `cordis.patch.yml`(通过 allocation 包,带守护+备份)
8. 每轮完成跑 `pnpm typecheck` + `pnpm test` + 构建验证;发布用 make-release.ps1
9. **PowerShell 环境怪癖**:
   - `$p:` 会解析为驱动器 → 用 `("{0}: {1}" -f ...)` 格式化
   - here-string 传给 node 会坏 → 先写文件再 `node file`
   - Start-Job 缺 npm 全局 PATH → 用完整 `C:\Program Files\nodejs\node.exe`
   - plain node 读不了 asar,`ELECTRON_RUN_AS_NODE` 可以
   - `Invoke-WebRequest` 在 NonInteractive 下被禁 → 用 Node fetch
   - pnpm 的 .ps1 包装把命令回显写到 stderr → 别把 stderr 当失败,看 `$LASTEXITCODE`
10. 用户付费开发,要求**功能真正端到端可用**;每轮验证不只 typecheck,要实际起服务测试

---

## 11. 已知问题与注意事项

- **git push 到 github.com 直连常超时**:PowerShell/node fetch 走系统代理 12450 可通;git 需临时 `git config http.proxy http://127.0.0.1:12450` 推送后 unset
- **DSH Desktop 升级会失效提取缓存**:asar 变化后 `.complete` 标记仍在,缓存可能旧;ensureCacheIntegrity 只补空目录,若 dsh 本体大版本升级建议删缓存全量重提取
- **pnpm 清空 junction 目标**:安装插件时可能清空缓存包(commander/ws 等),启动前 ensureCacheIntegrity 已自动补回
- **插件 peer 依赖不自动装**:市场安装只装插件本体,peer(如 dsh-web-search-pro → @anweat/dsh-browser)需手动装;启动失败提示已覆盖
- **灵枢/aeis Python 模块缺失**:DSH 内置组件需要 Python 模块(linge/aeis),当前环境缺 → 仅诊断提示,非 godsh 可修复
- **空 patch 文件**(0 字节)已修复为写 `[]`;若见到旧版遗留 0 字节文件,启动自愈会恢复
- **verify-release.mjs 需传版本参数**:`node scripts/verify-release.mjs 0.3.1`
- **update-release.js 上传过滤**:只处理 `godsh-<version>-*` + SHA256SUMS.txt,避免混入旧版本资产

---

## 12. 关键 API 端点索引

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 环境健康(launcher/dshHome/node/pnpm/dsh/errors) |
| GET | /api/profiles | 环境列表(含 bundles/dependencies/patch 状态) |
| POST/DELETE | /api/profiles | 新建/删除环境 |
| GET | /api/profiles/status?names= | 合并轮询运行状态 |
| POST | /api/profiles/:name/start /stop | 启停(串行队列+自愈) |
| GET | /api/profiles/:name/log /status | 日志/状态 |
| GET | /api/profiles/:name/plugins | 已安装插件清单 |
| POST | /api/profiles/:name/plugins | 单插件 add/remove/update(marketName 解析) |
| POST | /api/profiles/:name/plugins/uninstall | 智能卸载(依赖→pnpm, bundle→bundles) |
| POST | /api/profiles/:name/plugins/batch | 批量安装(串行+逐包结果) |
| POST/GET | /api/profiles/:name/plugins/update-all(+/progress) | 全部更新后台任务+进度 |
| GET | /api/plugins | 本地插件清单 |
| GET | /api/market?q= | 市场搜索 |
| GET | /api/market/categories | 22 分类概览(含中文名+计数) |
| GET/POST | /api/allocations | 分配列表/创建 |
| PATCH/DELETE | /api/allocations/:id | 启用禁用/删除 |
| GET | /api/allocations/available | 每环境可分配清单(含描述/版本/分类) |
| POST | /api/allocations/assign-category | 按分类一键分配 |
| POST | /api/allocations/move-with-install | 跨环境剪切并复制(自动安装) |
| POST | /api/allocations/:id/move | 跨环境移动 |
| POST | /api/allocations/apply /reorder | 写回 patch / 排序 |
| GET | /api/ports | 端口占用视图 |
| GET/POST | /api/kernels 等 | 内核模板/实例 |
| GET/PUT | /api/unified-kernel 等 | 统一内核配置 |
| GET | /api/dsh/status /versions /install /update | DSH 版本管理 |
| GET/POST | /api/dsh-envs 等 | DSH 环境管理 |
| GET/PUT | /api/settings | 设置 |
| GET/POST | /api/backup(+/restore) | 数据备份/恢复 |
| POST | /api/reset | 重置(data/all/dsh-all) |

---

## 13. 版本历史

| 版本 | 关键内容 |
| --- | --- |
| v0.2.2 | 初始框架(目录名来源) |
| v0.2.4 | 拖拽引擎重构(Pointer Events)、统一内核、批量启停 |
| v0.2.5 | CORS 白名单、端口占用视图、启动诊断 |
| v0.2.6 | 官方 bundle junction 断链修复(asar 提取自愈) |
| v0.2.7 | 市场下载修复(CORS + npm 字段)、环境启动多层修复 |
| v0.2.8 | 点击即分配、可视化进度、启动加载画面、拖动=剪切并复制、市场已安装状态稳定、插件悬停简介 |
| v0.2.9 | **按市场分类自动分配**(22 分类分组 + ⚡全部分配)、分类概览 |
| v0.2.10 | **环境启动修复**:patch 空文件/缓存被清空/peer 缺失三层根因 + 启动自愈 |
| v0.3.1 | 版本号升至 0.3.1(0.3.x 首个正式版,包含以上全部) |

---

## 14. 下一步方向(供新会话规划,未确认)

- 重新构建 0.2.6 安装器(若用户要,该 Release 目前只有源码 zip)
- DSH Desktop 升级后缓存失效策略(版本指纹对比 asar)
- 插件 peer 依赖自动补装(安装时解析 package.json peerDependencies)
- 灵枢/aeis Python 模块自动安装引导
