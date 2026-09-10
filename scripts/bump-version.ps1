# godsh 版本号统一更新脚本（SSOT 版）
# 用法: pwsh -File scripts/bump-version.ps1 -Version 0.2.0
#
# 唯一真源（SSOT）= 仓库根 package.json 的 version。
# 本脚本只负责「机器可判定、且无法派生」的目标：
#   1) 根 + apps/* + packages/* 的 package.json
#   2) apps/launcher/src-tauri/Cargo.toml
#   3) apps/launcher/src-tauri/tauri.conf.json
#
# 以下目标已改为「从 SSOT 派生」，本脚本**不再**写入（写了反而会制造第二真源）：
#   - packages/core/src/config-store.ts  → 改用 APP_VERSION（packages/core/src/version.ts）
#   - packages/dsh-plugin/src/backup-manager.ts → 改用 APP_VERSION
#   - data/config.json 的 launcher.version → readConfig() 始终以 APP_VERSION 为准
#   - apps/launcher/src-tauri/resources/server.mjs → 构建产物，由 build:server 注入版本
#
# 更新后必须执行的校验：
#   pnpm build:server ; node scripts/verify-version.mjs ; pnpm test
#
# 以下目标需要**人工**更新（脚本不碰，避免破坏历史记录）：
#   - CHANGELOG.md（新增条目）、release/RELEASE_NOTES.md（当前版本段）
#   - README.md 的「当前版本」与下载文件名
#   - QUICKSTART.md / 使用说明.md 的版本标注
param([Parameter(Mandatory=$true)][string]$Version)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+') {
    Write-Host "版本号格式应为 x.y.z（如 0.2.0）" -ForegroundColor Red
    exit 1
}

# 统一无 BOM 写回（Set-Content -Encoding UTF8 会写入 BOM，导致 serde_json 解析失败）
function Write-NoBom($path, $content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# 1) 所有 package.json 的 version（根 = SSOT，其余为平级副本）
$pkgs = @(
    (Get-Item "$root\package.json"),
    (Get-ChildItem "$root\packages\*\package.json"),
    (Get-ChildItem "$root\apps\*\package.json")
) | ForEach-Object { $_.FullName }

foreach ($p in $pkgs) {
    $json = Get-Content $p -Raw | ConvertFrom-Json
    $json.version = $Version
    Write-NoBom $p ($json | ConvertTo-Json -Depth 10)
    Write-Host "  package.json: $p -> $Version" -ForegroundColor Gray
}

# 2) src-tauri/Cargo.toml
$cargo = "$root\apps\launcher\src-tauri\Cargo.toml"
$cargoText = (Get-Content $cargo -Raw) -replace '(?m)^version = "[\d.]+"$', "version = `"$Version`""
Write-NoBom $cargo $cargoText
Write-Host "  Cargo.toml -> $Version" -ForegroundColor Gray

# 3) src-tauri/tauri.conf.json
$conf = "$root\apps\launcher\src-tauri\tauri.conf.json"
$c = Get-Content $conf -Raw | ConvertFrom-Json
$c.version = $Version
Write-NoBom $conf ($c | ConvertTo-Json -Depth 10)
Write-Host "  tauri.conf.json -> $Version" -ForegroundColor Gray

# 4) 校验：确认没有任何被写入的文件带 BOM
$allFiles = @($pkgs) + @($cargo, $conf)
foreach ($f in $allFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($f)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "警告：$f 仍含 BOM" -ForegroundColor Yellow
    }
}

Write-Host "版本号已统一为 $Version（SSOT = 根 package.json）" -ForegroundColor Green
Write-Host ""
Write-Host "下一步（必做）：" -ForegroundColor Cyan
Write-Host "  pnpm build:server                    # 重新打包后端（注入新版本）" -ForegroundColor Cyan
Write-Host "  node scripts/verify-version.mjs      # 一致性断言" -ForegroundColor Cyan
Write-Host "  pnpm test                            # 含 version.test.ts" -ForegroundColor Cyan
Write-Host "还需人工更新：CHANGELOG.md / release/RELEASE_NOTES.md / README.md / QUICKSTART.md / 使用说明.md" -ForegroundColor Yellow
