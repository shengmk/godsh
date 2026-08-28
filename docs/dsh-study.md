# DSH 框架学习笔记（基于本地源码与 .dsh 备份）

> 本文整理自 `deepseek-harness` 源码、`docs/` 文档、本机 `.dsh` 目录及 `dshmarket` 插件包。
> 目的是为“dsh 环境配置启动器”提供真实的框架依据。

## 1. DSH 是什么

- **DSH = DeepSeek Harness**，DeepSeek AI 开源的 agent harness（智能体框架）。
- 底层由 **Cordis** 驱动，核心设计是 **一切皆插件**。
- 运行方式：
  - `dsh web`：启动 Web UI，默认 `http://127.0.0.1:3080`
  - `dsh --profile <name> ...`：使用指定 profile 启动
  - `dsh plugin --profile <name> add <pkg>`：向 profile 安装插件

> **关键（实测 v0.1.1-rc.1）**：`dsh web` 是 `--profile web` 的**硬编码别名**，不接受 `--profile`，
> 因此 `dsh --profile <name> web` 会报 `web takes none of parent --profile ...`。
> 启动任意 Profile 的 Web UI 的正确姿势是 `dsh --profile <name> --port <port> --no-open`：
> 这里没有 `web` 字样，`--port/--host/--no-open` 是 Web App（dsh-web-app）的 flag，作为 inner args 传入。

## 2. 核心框架：Cordis

Cordis 是插件容器/依赖注入框架：

- 插件是一个导出 `apply(ctx, config?)` 的模块。
- 插件通过 `ctx` 注册服务、工具、事件监听、副作用。
- 所有注册都是 **effect**，插件卸载时自动清理。
- 插件可以声明 `inject`，依赖其他服务就绪后才加载。
- 插件支持三种形态：**函数式、对象式、类式（Service）**。
- 插件热重载（HMR）来自 Cordis 的 entry/fiber 生命周期。

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  ctx.on('some/event', () => {
    // do something
  })
}
```

## 3. 插件框架：Profile / Bundle / Client Plugin

DSH 的“插件安装”不是简单复制文件，而是通过 **profile + bundle** 组合：

| 概念 | 类比 | 说明 |
| --- | --- | --- |
| Profile | conda 环境 | `$DSH_HOME/profiles/<name>/`，是一个可启动环境 |
| Bundle | pip 包 / conda 包 | 一个 npm 包 + `cordis.patch.yml` 配置层，声明 `dsh.bundle` |
| Client Plugin | 前端插件 | 包声明 `dsh.client`，提供一个 `./client` 浏览器 bundle |
| dshmarket | Anaconda 软件源 | DSH 可视化插件市场，可浏览/搜索/安装/更新 |

### 3.1 Bundle（宿主插件/组合包）

一个可安装的 bundle：

```text
hello-plugin/
├─ package.json       # 声明 dsh.bundle
├─ cordis.patch.yml   # 插入/覆盖插件行的 patch
└─ index.js           # 插件入口
```

`package.json` 关键字段：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

### 3.2 Client 插件（跑在同一个 Web 内核里）

浏览器侧插件也是 Cordis 插件，但代码需要打包成浏览器可加载的 bundle：

- 包声明 `dsh.client`：

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-runtime"
      ]
    }
  },
  "exports": {
    "./client": "./client/client.js"
  }
}
```

- DSH host 侧扫描配置树中已挂载的 client 插件，生成启动图：
  `window.__DSH_BOOT__ = { rev, entries: [{ id, url, rev, inject, immediately }] }`
- 浏览器加载 `/plugins/<id>/client.js?rev=...`，由 **同一个 Web 内核** `@deepseek-ai/dsh-client-web` 统一装载。

### 3.3 Profile

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dshmarket": "^1.21.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dshmarket"
      ]
    }
  }
}
```

启动时按顺序叠加：

1. profile 的 `bundles` 列表中的 bundle patch
2. profile 的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. 命令行 `--patch` overlay

## 4. Web 内核

DSH 的“同一个 Web 内核”具体指：

- **Host 侧**：`dsh web` 启动一个 Node HTTP 服务，包含：
  - `dsh-host-webserver`：HTTP 路由
  - `dsh-host-apiproxy`：API 网关/RPC
  - `dsh-host-frontend-static`：SPA 静态资源
  - `dsh-client-modules` Node 半：扫描 client 插件并生成启动图
- **Client 侧**：`@deepseek-ai/dsh-client-web` 是浏览器 Shell 内核：
  - 构建浏览器模块系统
  - 挂载同一套 vendored Cordis Loader
  - 把所有 client 插件作为 entry 挂载到同一个 Shell 中
  - 通过 `AppRoot` 门禁切换加载页 → 完整 UI
- **扩展方式**：新增功能不是再开一个浏览器/WebView，而是添加一个 `dsh.client` 插件包，挂载进同一个 Shell。

```text
浏览器里只有一个 Web Shell 内核
├─ dsh-client-web        # 外壳内核
├─ dsh-client-modules    # 浏览器模块系统
├─ dsh-client-connection # RPC
├─ dsh-client-runtime    # 共享服务
├─ dshmarket/client      # 插件市场 UI 插件
├─ 你的插件 A/client
└─ 你的插件 B/client
```

## 5. 插件下载 / 市场

- 官方社区市场：`dshmarket`
  - 安装：`dsh plugin --profile web add dshmarket`
  - 数据源：`https://awesome-dsh-plugin.com/plugins.json`
  - 能力：浏览、搜索、一键安装、更新、卸载、热启停、备份恢复、诊断
- 安装本质上是在 profile 目录中执行 `pnpm add <pkg>`，然后根据 `dsh.bundle` 自动维护 `dsh.profile.bundles`。
- 安全性：
  - 默认来源为 curated registry
  - pnpm 默认阻止 git 依赖的 `prepare` 构建脚本，需要显式 `allowBuilds`
  - 只从可信来源安装

## 6. 对照我们想做的 Launcher（Anaconda 类比）

| 概念 | Anaconda | DSH | dsh Launcher |
| --- | --- | --- | --- |
| 运行环境 | conda env | DSH profile | 环境/Profile 管理 |
| 语言运行时 | Python 版本 | dsh 本体 + Node runtime | 内核管理 |
| 库/包 | pip/conda 包 | dsh plugin / bundle | 插件下载与安装 |
| 软件源 | conda channel / pip index | dshmarket / awesome-dsh-plugin | 插件市场 |
| 图形入口 | Anaconda Navigator | 浏览器 Web UI | 我们要做的 Launcher |
| 环境安装包 | conda install | dsh plugin --profile <name> add | Launcher 内部封装 |
