# dsh 环境配置启动器 — 文件夹配置（提示词用）

> 本文件结合真实 DSH 目录结构和 Launcher 扩展目录，给 AI / Agent 作为项目结构上下文。

## 1. DSH 本体的关键目录（参考）

```text
$DSH_HOME/                          # 例如 C:\Users\<user>\.dsh
├─ profiles/                        # 所有 Profile（conda env 的类比）
│  ├─ web/                          # 一个可启动环境
│  │  ├─ package.json               # dsh.profile.bundles + dependencies
│  │  ├─ cordis.yml                 # profile 根入口，通常是空列表
│  │  ├─ cordis.patch.yml           # 用户级启用/禁用/配置插件
│  │  ├─ pnpm-lock.yaml
│  │  └─ pnpm-workspace.yaml
│  ├─ ui-skins/
│  └─ ...
├─ dsh-launcher/                    # 现有启动器运行时目录
│  ├─ dsh.log
│  └─ service-pid-<port>.txt
├─ sessions/                        # 会话数据
├─ skills/                          # 技能包
├─ storages/                        # 工作区缓存
└─ cordis.patch.yml                 # home 级 patch
```

DeepSeek Harness 源码目录（参考）：

```text
deepseek-harness/
├─ apps/
│  ├─ cli/                          # dsh CLI 入口，含 plugin.ts
│  └─ web/                          # Web 前端入口
├─ packages/
│  ├─ client/                       # 浏览器侧包族
│  │  ├─ web/                       # Web Shell 内核 dsh-client-web
│  │  ├─ modules/                   # 浏览器模块系统
│  │  ├─ connection/                # RPC 通信
│  │  └─ ui-*/                      # UI 插件
│  ├─ host/                         # 宿主侧：webserver/apiproxy/frontend-static
│  ├─ bundle/
│  │  ├─ base/                      # 每个 profile 的第一层
│  │  ├─ web-app/                   # 浏览器表层组合包
│  │  └─ headless/                  # headless 表层
│  └─ ...
└─ docs/
```

## 2. Launcher 推荐目录结构

```text
dsh-launcher/
├─ apps/
│  ├─ launcher/
│  │  ├─ src/                       # 主启动器逻辑
│  │  ├─ main.ts                    # 进程入口
│  │  └─ package.json
│  └─ shell-web/
│     ├─ src/                       # 可选：Launcher 自身管理界面
│     └─ index.html
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  ├─ env-detect.ts              # 检测 node/pnpm/dsh/$DSH_HOME
│  │  └─ process-manager.ts         # 启停 dsh web
│  ├─ profile-manager/
│  │  ├─ src/
│  │  ├─ scanner.ts                 # 扫描 profiles/
│  │  └─ profile-editor.ts          # 维护 package.json / cordis.patch.yml
│  ├─ plugin-registry/
│  │  ├─ src/
│  │  ├─ bundle.ts                  # 读取 dsh.bundle
│  │  └─ client-plugin.ts           # 读取 dsh.client
│  ├─ allocation/
│  │  ├─ src/
│  │  └─ allocation-manager.ts      # 分配关系 + patch 生成
│  ├─ kernel-manager/
│  │  ├─ src/
│  │  ├─ kernel-template.ts
│  │  └─ kernel-process.ts          # 内核实例启停
│  ├─ marketplace/
│  │  ├─ src/
│  │  ├─ dshmarket-client.ts        # 拉取 awesome-dsh-plugin
│  │  └─ installer.ts               # 封装 dsh plugin add/update/remove
│  └─ security/
│     ├─ src/
│     ├─ source-policy.ts           # 来源白名单
│     └─ build-permission.ts        # pnpm allowBuilds 管理
├─ profiles/                        # Launcher 管理的 Profile 快照/模板
│  └─ web/                          # 可选的模板 Profile
├─ plugins/
│  ├─ hello-world/                  # 本地 bundle 示例
│  │  ├─ package.json
│  │  ├─ cordis.patch.yml
│  │  └─ index.js
│  └─ my-client-plugin/             # 本地 client 插件示例
│     ├─ package.json
│     ├─ src/
│     └─ client/
├─ kernels/
│  ├─ templates/
│  │  ├─ web-default/template.json
│  │  └─ headless/template.json
│  └─ instances/                    # 运行时生成的内核实例
├─ data/
│  ├─ config.json
│  ├─ profiles.json
│  ├─ plugins.json
│  ├─ kernels.json
│  ├─ allocations.json
│  └─ logs/
├─ docs/
│  ├─ dsh-study.md
│  ├─ workflow.md
│  ├─ folder-config.md
│  ├─ gui-design.md
│  └─ iteration-log.md
├─ scripts/
│  ├─ dev.ps1
│  ├─ build.ps1
│  └─ pack-plugin.ps1
├─ PROMPT.md                       # 常驻 AI 开发提示词
└─ README.md
```

## 3. 关键文件约定

| 路径 | 作用 | 格式 |
| --- | --- | --- |
| `profiles/<name>/package.json` | Profile 清单，`dsh.profile.bundles` | JSON |
| `profiles/<name>/cordis.patch.yml` | 启用/禁用/配置插件 | YAML |
| `plugins/<pkg>/package.json` | Bundle/Client 插件清单 | JSON |
| `plugins/<pkg>/cordis.patch.yml` | Bundle 提供的配置层 | YAML |
| `plugins/<pkg>/index.js` | Bundle 插件入口 | JS/TS |
| `plugins/<pkg>/client/client.js` | Client 插件 bundle | JS |
| `kernels/templates/*/template.json` | 内核模板 | JSON |
| `data/config.json` | Launcher 全局配置 | JSON |
| `data/allocations.json` | 插件分配关系 | JSON |
| `data/kernels.json` | 内核实例清单 | JSON |

## 4. 关键 manifest 示例

### 4.1 Bundle 插件 package.json

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### 4.2 Bundle 的 cordis.patch.yml

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

### 4.3 Client 插件 package.json

```json
{
  "name": "dsh-my-client-plugin",
  "version": "0.1.0",
  "type": "module",
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  },
  "exports": {
    "./client": "./client/client.js"
  }
}
```

### 4.4 Profile package.json

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:../../plugins/hello-world",
    "dshmarket": "^1.21.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-hello-plugin",
        "dshmarket"
      ]
    }
  }
}
```

### 4.5 内核模板 template.json

```json
{
  "id": "web-default",
  "type": "web",
  "name": "DSH Web 默认内核",
  "command": ["dsh", "--profile", "{profile}", "--port", "{port}", "--no-open"],
  "defaultPort": 3080,
  "resource": {
    "memoryMB": 1024,
    "cpu": 1
  }
}
```

## 5. 使用建议（给 Agent / 提示词）

1. 先读 `docs/dsh-study.md` 了解 DSH 真实框架。
2. 再读 `docs/workflow.md` 了解业务流程。
3. 安装/卸载插件时**优先调用 `dsh plugin --profile <name> add/remove <pkg>`**，不要手工改 `node_modules`。
4. 启用/禁用插件通过编辑 `profiles/<name>/cordis.patch.yml` 完成。
5. 所有 client 插件统一由同一个 `dsh-client-web` 内核加载，不要为插件单独启动浏览器。
6. 内核管理 = 管理内核模板和 dsh 服务进程，不是修改 DSH 源码。
7. 插件分配关系写入 `data/allocations.json`，最终落地为 profile 的 bundles + patch。

## 6. 最小可运行版本（MVP）

```text
dsh-launcher/
├─ packages/core/env-detect.ts
├─ packages/profile-manager/scanner.ts
├─ packages/marketplace/installer.ts
├─ packages/kernel-manager/kernel-process.ts
├─ profiles/web/package.json
├─ data/config.json
├─ scripts/dev.ps1
└─ README.md
```
