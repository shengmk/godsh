# dsh Launcher 版本号统一更新脚本
# 用法: pwsh -File scripts/bump-version.ps1 -Version 0.2.0
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

# 1) 所有 package.json 的 version
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

# 4) data/config.json launcher.version
$cfg = "$root\data\config.json"
$d = Get-Content $cfg -Raw | ConvertFrom-Json
$d.launcher.version = $Version
Write-NoBom $cfg ($d | ConvertTo-Json -Depth 10)
Write-Host "  data/config.json -> $Version" -ForegroundColor Gray

# 5) packages/core/src/config-store.ts 的 DEFAULT_CONFIG.launcher.version（硬编码兜底版本）
$store = "$root\packages\core\src\config-store.ts"
$storeText = (Get-Content $store -Raw) -replace "version: '[\d.]+'", "version: '$Version'"
Write-NoBom $store $storeText
Write-Host "  config-store.ts -> $Version" -ForegroundColor Gray

# 6) 校验：确认没有任何文件带 BOM
$allFiles = @($pkgs) + @($cargo, $conf, $cfg, $store)
foreach ($f in $allFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($f)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "警告：$f 仍含 BOM" -ForegroundColor Yellow
    }
}

Write-Host "版本号已统一为 $Version" -ForegroundColor Green
