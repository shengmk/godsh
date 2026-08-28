# godsh 快速开始（Quick Start）

> dsh 环境配置启动器 —— 像 **Anaconda Navigator** 一样管理你的 **DeepSeek Harness（dsh）** 环境、插件与内核。

## 1. 前置要求

| 依赖 | 说明 | 检查 |
| --- | --- | --- |
| Windows 10 / 11 | 需 WebView2（Win11 自带） | — |
| Node.js ≥ 20 | 桌面应用内置后端运行需要 | `node --version` |
| dsh CLI | DeepSeek Harness 本体 | `dsh --version` |
| DSH_HOME | 默认 `C:\Users\<你>\.dsh` | `echo $env:DSH_HOME` |

## 2. 安装

**方式 A：桌面安装器**

1. 下载 `release/godsh-0.1.0-x64-setup.exe`
2. 双击安装（安装到 `%LOCALAPPDATA%\godsh`），从开始菜单/桌面启动「godsh」

**方式 B：便携版（ZIP）**

1. 下载 `release/godsh-0.1.0-x64.zip`，解压
2. 双击文件夹里的 `godsh.exe` 即可（**保持解压后文件夹内文件完整，不要单独拷走 exe**——需要旁边的 `WebView2Loader.dll`）

**方式 C：源码运行（Web 模式 / 开发）**

```powershell
cd godsh
pnpm install          # 安装依赖
pnpm build:web        # 构建前端
pnpm serve            # 启动 API + Web UI → http://127.0.0.1:4780
```

## 3. 第一次启动

打开 godsh 后，你会看到四个页：

| 页面 | 作用 |
| --- | --- |
| **环境** | 列出 `$DSH_HOME/profiles` 下所有环境，一键启动/停止、看日志、打开 Web UI |
| **插件市场** | 浏览 awesome-dsh-plugin，搜索并安装插件到指定环境 |
| **插件分配** | 把插件分配给环境，控制启用/禁用/顺序，写回 `cordis.patch.yml` |
| **内核管理** | 内核模板 + 实例的新建、启停、删除 |

**三步上手：**

1. **启动一个环境**：进入「环境」页 → 点目标环境的「启动」→ 等状态变为「运行中」→ 点「打开 ↗」进入 dsh Web UI
2. **装一个插件**：进入「插件市场」→ 选目标环境 → 搜索（如 `dshmarket`）→ 点「安装」
3. **分配插件**：进入「插件分配」→ 选环境 → 填插件 ID → 「分配」→「应用（写回 patch）」

## 4. 常用快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+1` ~ `Ctrl+4` | 切换四个页面 |

---
