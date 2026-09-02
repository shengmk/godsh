# godsh 快速上手指南 (Quick Start)

> **版本**：v0.4.1+ (原生 DSH/Cordis 插件与高级特性版)  
> **定位**：面向 DeepSeek Harness (DSH) 的多环境管理、零重启热插拔与一键配置化装机工作台。

---

## ⚡ 核心能力速览

1. **零重启热插拔 (HMR)**：通过编辑 `cordis.patch.yml`，在 1 秒内无感启停插件，无需中断会话或杀进程。
2. **5 维极速工作流 (Workflows)**：单命令 / 单次点击自动创建环境、批量安装分类插件并激活规则（平均耗时 10~25 秒）。
3. **全局常驻任务中心 (Task Center)**：右下角悬浮徽标 + 流式终端日志抽屉，切页后台持续推进，日志永不丢失。
4. **多版本快照热备份 (Disaster Recovery)**：一键全量备份环境配置（`package.json` + bundles + patch），遇到插件冲突时 1 秒秒级回滚。
5. **AI Agent 动态工具集成**：在 DSH 对话中直接让 AI 帮你查询环境、热插拔插件、执行装机流水线。

---

## 🚀 快速运行的三种模式

### 模式一：可视化工作台模式 (GUI Workbench)

推荐日常环境管理、批量装机与直观查看插件状态使用。

```powershell
# 1. 启动轻量 API 后端 (默认监听 http://127.0.0.1:4999)
pnpm serve

# 2. 另开终端启动前端 Web 界面
pnpm dev:web
```
- 浏览器访问：**`http://localhost:5173`**
- **操作技巧**：
  - 点击顶部 **`⚡ 工作流 / 规则`** ➔ 选择 **AI 对话套件工作流** 或 **开发套件工作流** ➔ 点击 **执行工作流**；
  - 展开右下角 **全局任务中心** 黑色抽屉，实时查看每一步进度与标准输出。

---

### 模式二：DSH 原生插件模式 (DSH Plugin)

将 godsh 作为标准 Cordis 插件无缝挂载至 DSH 任意环境（如 `test-profile` 或 `dev-workspace`）。

#### 1. 新建并配置测试专用环境 (Profile)
在 `~/.dsh/profiles/test-profile` 下创建配置文件：

- **`package.json`**：
  ```json
  {
    "name": "dsh-profile-test-profile",
    "private": true,
    "dependencies": {
      "@godsh/dsh-plugin": "file:../../packages/dsh-plugin"
    },
    "dsh": {
      "profile": {
        "bundles": ["@deepseek-ai/dsh-base"]
      }
    }
  }
  ```

- **`cordis.patch.yml`**：
  ```yaml
  - insert:
      - id: "@godsh/dsh-plugin"
  ```

#### 2. 启动 DSH 运行环境
```powershell
# 启动 Web UI 模式
dsh --profile test-profile web

# 或启动交互式终端模式
dsh --profile test-profile
```

#### 3. 在 AI 对话中直接调用动态工具
插件加载后，DSH Agent 会自动获得以下 4 个原生能力：
- **`godsh_list_profiles`**：AI 自动获知系统内所有 Profile 及其 bundles。
- **`godsh_workflow_execute`**：例如在对话框输入 *“帮我在 test-profile 安装开发套件”*，AI 自动触发执行工作流。
- **`godsh_toggle_plugin_hot`**：对特定插件执行零重启热禁用 / 启用。
- **`godsh_snapshot_backup`**：执行危险改动前自动打快照。

---

### 模式三：自动化测试与类型检查 (Dev & Test)

```powershell
# 运行全量 36 个单元测试用例
pnpm test

# 全工作区 TypeScript 严格类型检查
pnpm typecheck

# 编译前后端生产产物
pnpm build:web
pnpm build:server
```

---

## 🛠️ 目录与模块架构指南

| 路径 | 说明 | 关键职责 |
| :--- | :--- | :--- |
| `packages/dsh-plugin/` | **DSH 原生插件包** | `GodshService`、Agent Tools 注册、Client Slots 注入、长期思维记忆 |
| `packages/profile-manager/` | **环境管理库** | 读写 `package.json`、`cordis.patch.yml` 规范解析与序列化 |
| `packages/marketplace/` | **市场与安装器** | 市场索引拉取、国内镜像源加速、本地代理探测缓存、批量单次 `pnpm add` |
| `packages/allocation/` | **插件分配器** | 环境间的插件启用规则与优先级排序 |
| `packages/core/` | **底层运行内核** | 子进程派生、`onLog` 流式输出拦截、进程治理 |
| `apps/launcher/` | **API 后端服务** | 提供工作流调度路由与 WebSocket / 轮询任务端点 |
| `apps/shell-web/` | **可视化前端** | `KeepAlive` 常驻页面容器、全局任务中心抽屉、工作流模态框 |

---

## 💡 最佳实践提示

- **避免硬重启**：在 DSH 运行中，尽量通过修改 `cordis.patch.yml`（或通过 `godsh_toggle_plugin_hot` 工具）调整插件，Cordis 监听器会在 1 秒内完成 HMR 热替换。
- **重大变更前备份**：在批量同步规则或执行陌生工作流前，点击右键「📤 导出环境包」或调用 `godsh_snapshot_backup`，确保零风险实验。
