# 发布到 GitHub 完整指南

> 本文档教你如何把 godsh 发布到 GitHub 并创建 Release（含安装包附件）。
> 项目已初始化 git 仓库并完成全部提交，可直接进行以下步骤。

---

## 一、准备（一次性）

### 1. 创建 GitHub 账号并登录
- 打开 https://github.com → 注册/登录

### 2. 安装 Git（若未装）
- 下载 https://git-scm.com/download/win 安装（默认选项即可）
- 验证：打开 PowerShell 输入 `git --version` 有输出版本号即成功

---

## 二、创建远程仓库

1. 登录 GitHub → 右上角 **+** → **New repository**
2. 填写：
   - **Repository name**：`godsh`
   - **Description**：`godsh — dsh 环境配置启动器（Anaconda Navigator 类比）— DeepSeek Harness 环境/插件/内核管理`
   - **Public**（公开）或 **Private**（私有）— 按需
   - ⚠️ **不要勾选** "Add a README" / ".gitignore" / "License"（项目里已有）
3. 点击 **Create repository**

---

## 三、推送项目代码到 GitHub

打开 PowerShell，进入项目目录：

```powershell
cd C:\Users\Shengmingkai\Desktop\dsh__launcher\dsh-launcher-project-0.2.2

# 1) 添加远程仓库地址
git remote add origin https://github.com/shengmk/godsh.git

# 2) 查看远程（应显示 origin）
git remote -v

# 3) 推送到 GitHub（首次会要求登录）
git push -u origin master
```

> 首次推送会弹出 GitHub 登录窗口（浏览器）或要求输入用户名/Token。
> 若要求 Token：GitHub → 头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → 勾选 `repo` → 生成后复制，粘贴到密码框。

推送成功后，刷新 GitHub 仓库页面即可看到全部代码。

---

## 四、创建 Release（发布版本 + 上传安装包）

### 方法 A：网页操作（最简单，推荐）

1. GitHub 仓库页面 → 右侧 **Releases** → **Create a new release**（或左侧 Releases → Draft a new release）
2. 填写：
   - **Tag**：`v0.2.5`（点 "Choose a tag" → 输入 v0.2.5 → Create new tag）
   - **Target**：`master`
   - **Release title**：`v0.2.5 — 市场下载修复 + 批量扩容 + 更新反馈 + 性能优化`
   - **Write**（发布说明）：把 `release/RELEASE_NOTES.md` 的内容粘贴进来
3. **Attach binaries**（拖入/选择以下文件）：
   - `release\godsh-0.2.5-x64-setup.exe`
   - `release\godsh-0.2.5-x64.zip`
   - `release\SHA256SUMS.txt`
4. 点击 **Publish release**

### 方法 B：命令行（gh CLI）

```powershell
# 安装 GitHub CLI：winget install GitHub.cli  →  gh auth login
gh release create v0.2.5 `
  --title "v0.2.5 — 市场下载修复 + 批量扩容 + 更新反馈 + 性能优化" `
  --notes "$(Get-Content release\RELEASE_NOTES.md -Raw)" `
  release\godsh-0.2.5-x64-setup.exe `
  release\godsh-0.2.5-x64.zip `
  release\SHA256SUMS.txt
```

---

## 五、验证发布

1. 打开仓库 → **Releases** → 应看到 `v0.2.5`
2. 点开 Release → 能看到安装包附件 + 发布说明
3. 其他用户可直接下载 `godsh-0.2.5-x64-setup.exe` 安装使用

---

## 六、后续版本发布流程（每次迭代）

```powershell
# 1) 改版本号（0.2.4 → 0.2.5）
pwsh -File scripts\bump-version.ps1 -Version 0.2.5

# 2) 构建 + 测试
pnpm typecheck
pnpm test
pnpm test:smoke

# 3) 打包发布产物
pwsh -File scripts\make-release.ps1 -Version 0.2.5

# 4) 提交代码
git add -A
git commit -m "v0.2.5: ..."
git push

# 5) 创建 Release（网页操作或 gh release create v0.2.5 ...）
```

---

## 七、常见问题

| 问题 | 解决 |
| --- | --- |
| push 报 `rejected` / 远程有历史 | 首次需 `git pull origin master --allow-unrelated-histories` 后重推 |
| push 要求 Token | 用 Personal Access Token 代替密码（见上） |
| 忘了上传安装包 | 编辑 Release → Attach binaries → 重新发布 |
| 想更新已发布的 Release | Releases → 对应版本 → Edit → 改说明/附件 → Update release |
| release 目录不进 git | 已配置 `.gitignore` 排除二进制，作为 Release 附件（正确做法） |

---

## 八、可选进阶

- **自动打包（GitHub Actions）**：仓库里已准备 `.github/workflows/release.yml`，推送 tag `v0.2.x` 时自动跑测试 + 打包 + 生成 Release 附件。启用即可（首次需确认 Actions 权限：Settings → Actions → General → Allow）。
- **项目徽章**：README 顶部的 `shengmk` 换成你的用户名后，即可显示 GitHub 徽章。
