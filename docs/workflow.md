# dsh 环境配置启动器 — 工作流程

> 本文基于真实 DSH 框架编写，适合作为开发实现或 AI 提示词参考。
> 整体类比：**Anaconda Navigator（Launcher）→ conda（dsh CLI）→ Python（dsh）→ 包（插件）→ 环境（Profile）**。

## 1. 核心概念

| 概念 | 说明 |
| --- | --- |
| DSH | DeepSeek Harness，DSH 本体，类比 Python |
| dsh CLI | `dsh` 命令，类比 conda |
| Profile | 一个可启动环境，位于 `$DSH_HOME/profiles/<name>/`，类比 conda env |
| Bundle | 可安装插件/组合包，声明 `dsh.bundle`，提供 `cordis.patch.yml` 配置层 |
| Client Plugin | 浏览器侧插件，声明 `dsh.client`，提供 `./client` bundle |
| Web Kernel | DSH 的统一 Web 客户端内核：`@deepseek-ai/dsh-client-web` |
| dshmarket | 插件市场，类比 conda channel / pip index |
| Allocation | 把插件分配给 Profile / 工作区，并决定启用、顺序、配置 |

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────┐
│              dsh Launcher UI（Anaconda Navigator）     │
│  环境管理 · 插件管理 · 内核管理 · 插件市场              │
└─────────────────────────────────────────────────────────┘
              │ 调用
              ▼
┌─────────────────────────────────────────────────────────┐
│                   dsh CLI / dsh web                     │
│   dsh plugin --profile <name> add <pkg>                 │
│   dsh --profile <name> --port <port> --no-open          │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│              DSH Profile（环境）                        │
│  profiles/<name>/package.json                           │
│  profiles/<name>/cordis.patch.yml                       │
│  dsh.profile.bundles = [base, web-app, plugins...]      │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│              DSH Web Host（宿主侧）                     │
│  webserver · apiproxy · frontend-static · client-modules│
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│        同一个 Web 内核（浏览器侧）                      │
│  dsh-client-web shell                                   │
│   ├─ dsh-client-modules                                 │
│   ├─ dsh-client-connection                              │
│   ├─ dsh-client-runtime                                 │
│   ├─ dshmarket/client                                   │
│   └─ 其他 client 插件                                   │
└─────────────────────────────────────────────────────────┘
```

## 3. 模块职责

| Launcher 模块 | 职责 |
| --- | --- |
| Profile Manager | 扫描/创建/删除 Profile，维护 `profiles/<name>/package.json` |
| Plugin Registry | 读取已安装插件、bundle、client 插件清单 |
| Allocation Manager | 把插件分配给 Profile / 工作区，生成启用/禁用 patch |
| Kernel Manager | 管理 dsh web 服务实例、Node/Python 内核、Web 内核模板 |
| Marketplace | 对接 dshmarket / awesome-dsh-plugin，执行安装/更新/卸载 |
| Security | 校验来源、检查构建脚本授权、保护敏感配置 |
| Config Store | 持久化 Launcher 自身配置、Profile 列表、内核实例 |

## 4. 核心工作流程

### 4.1 启动 Launcher

```text
用户打开 Launcher
  → 检测环境：node、pnpm、dsh
  → 扫描 $DSH_HOME/profiles/
  → 读取 profiles/*/package.json 得到每个环境的状态
  → 读取 dsh-launcher 自己的 data/config.json
  → 显示环境列表、插件列表、内核状态
  → 用户选择 Profile 启动
```

启动一个 Profile：

```text
用户点击“启动 web 环境”
  → Launcher 调用 dsh --profile <name> --port <port> --no-open
  → 记录 service-pid / 端口 / 日志
  → 等待 http://127.0.0.1:<port> 就绪
  → 打开浏览器 / 内置 WebView
  → 进入 dsh Web UI（同一个 Web 内核）
```

关键点：

- 失败时读取 dsh.log 尾部并给出可读错误，例如 `cordis.patch.yml` 格式错误。
- 不同 Profile 使用不同端口，但浏览器端始终是同一个 dsh Web 内核 Shell。

### 4.2 插件下载与安装

```text
用户打开插件市场
  → 从 dshmarket / awesome-dsh-plugin 拉取插件索引
  → 选择插件与版本
  → Launcher 执行 dsh plugin --profile <name> add <pkg>
  → pnpm 在 profile 目录安装依赖
  → dsh plugin 自动根据 dsh.bundle 维护 dsh.profile.bundles
  → 若包含 client 插件，构建/发布 ./client bundle
  → HMR 热加载，或提示重启 dsh web
```

关键点：

- 安装命令本质是 `pnpm add <pkg>`。
- 只安装来源可信的插件；git 插件需要处理 pnpm `allowBuilds`。
- 安装后立即检查 `dsh.profile.bundles` 是否更新。

### 4.3 插件分配管理（Profile 级）

```text
用户选择 Profile
  → 查看该 Profile 已安装/已启用的插件
  → 添加插件到当前 Profile：
      - 已安装但未启用 → 写入 cordis.patch.yml 插入行
      - 已启用 → 可调整顺序、配置、禁用
  → 禁用插件：在 cordis.patch.yml 写入 disabled: true
  → 保存后交给 dsh HMR，无需重启即可生效
```

```yaml
# profiles/<name>/cordis.patch.yml 示例
- insert:
    - id: dsh-market
      name: dshmarket
- insert:
    - id: hello
      name: dsh-hello-plugin
      disabled: true
```

关键点：

- 一个插件可以同时分配给多个 Profile。
- “工作区绑定”可以理解为：某个工作区/项目启动时自动选择指定 Profile。

### 4.4 内核管理 / 新建内核

在 DSH 语境下，“内核”分成两层：

1. **Web 内核**：DSH 的浏览器 Shell 内核 `dsh-client-web`，所有 client 插件共享。
2. **运行内核**：支撑 dsh 的运行时，例如 Node.js、Python SDK Runtime。

Launcher 提供“内核管理”：

```text
用户进入内核管理
  → 查看内核模板：
      - web-default（dsh web 服务 + dsh-client-web）
      - headless（dsh headless 一次性运行）
      - node-runtime
      - python-runtime
  → 新建内核实例：
      1. 选择模板
      2. 指定名称、端口、资源限制
      3. 选择关联 Profile
      4. 生成 data/kernels/<kernel-id>.json
      5. 启动/停止/重启/删除
```

关键点：

- “同一个 Web 内核”意味着不需要为每个插件启动独立浏览器内核。
- 新增内核能力 = 新增内核模板，不修改 dsh 本体。

### 4.5 插件挂载到同一个 Web 内核

```text
用户给 Profile 添加了一个 client 插件
  → Launcher 执行 dsh plugin --profile <name> add <pkg>
  → profile 的 bundle patch 插入插件行
  → dsh host 扫描到 dsh.client 声明
  → host 生成浏览器启动图 window.__DSH_BOOT__
  → dsh-client-web 启动时加载该 client bundle
  → 插件出现在同一个 Web UI 中
```

```json
// 一个 client 插件 package.json 的关键声明
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime"]
    }
  },
  "exports": {
    "./client": "./client/client.js"
  }
}
```

关键点：

- client 插件之间不能直接值 import，协作走 Cordis 服务/inject。
- 插件 UI 不单独开页面，统一挂在同一个 Shell 里。
- HMR 可以热更新单个 client 插件。

### 4.6 插件更新 / 卸载

```text
更新：
  市场检测到新版本
  → dsh plugin --profile <name> update <pkg>
  → pnpm 更新依赖
  → dsh plugin 重新 reconcile bundles
  → 热加载或重启

卸载：
  用户卸载插件
  → dsh plugin --profile <name> remove <pkg>
  → pnpm 移除依赖
  → dsh plugin 从 bundles 中移除对应项
  → 若该插件写入了启用/禁用 patch，同时清理
```

## 5. 关键数据文件

```text
$DSH_HOME/
├─ profiles/
│  ├─ web/
│  │  ├─ package.json        # dsh.profile.bundles + dependencies
│  │  ├─ cordis.patch.yml    # 启用/禁用/配置插件
│  │  ├─ cordis.yml
│  │  └─ pnpm-lock.yaml
│  └─ ui-skins/
│     └─ ...
├─ dsh-launcher/
│  ├─ dsh.log
│  └─ service-pid-<port>.txt
└─ cordis.patch.yml          # home 级 patch
```

Launcher 自己的数据：

```text
data/
├─ config.json               # Launcher 配置
├─ profiles.json             # 管理的 Profile 快照
├─ kernels.json              # 内核实例
├─ allocations.json          # 插件分配关系
└─ logs/
```

## 6. 推荐实现顺序

1. **环境检测**：node / pnpm / dsh / `$DSH_HOME`
2. **Profile 扫描器**：读取所有 profiles/*/package.json
3. **进程管理**：启动/停止 dsh web，记录 PID/端口/日志
4. **Plugin Registry**：读取已安装依赖与 bundles
5. **Allocation Manager**：编辑 `cordis.patch.yml` 实现启用/禁用
6. **Marketplace**：封装 `dsh plugin add/update/remove`
7. **Kernel Manager**：新建/管理内核模板与实例
8. **UI**：环境卡片、插件市场、分配面板、内核管理页
