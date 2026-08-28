# godsh — Tauri 桌面壳构建脚本
# 背景：本机无 MSVC，使用 Rust GNU 工具链 + MinGW；GNU 工具链要求「路径无空格」，
# 因此把 src-tauri + 前端 dist 复制到无空格路径再构建。
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $env:USERPROFILE "godsh"
$targetDir = Join-Path $buildRoot "target"

# 0) 打包后端 + 构建前端（Tauri 模式：API 基址指向 127.0.0.1:4780）
Write-Host "打包后端 + 构建前端..." -ForegroundColor Cyan
Set-Location $projectRoot
pnpm build:server
if ($LASTEXITCODE -ne 0) { Write-Host "后端打包失败" -ForegroundColor Red; exit 1 }
pnpm --filter @godsh/shell-web build:tauri
if ($LASTEXITCODE -ne 0) { Write-Host "前端构建失败" -ForegroundColor Red; exit 1 }

# 0.5) 填充 resources 目录（server.mjs + 内核模板 + WebView2Loader.dll）
$resDir = Join-Path $projectRoot "apps\launcher\src-tauri\resources"
New-Item -ItemType Directory -Force $resDir | Out-Null
Copy-Item (Join-Path $projectRoot "apps\launcher\dist\server.mjs") (Join-Path $resDir "server.mjs") -Force
robocopy (Join-Path $projectRoot "kernels\templates") (Join-Path $resDir "templates") /E /NFL /NDL /NJH /NJS /NP | Out-Null

# WebView2Loader.dll：GNU 工具链下 WebView 初始化需要，随资源打包；应用启动时自愈复制到 exe 旁
$dllSources = @(
  (Join-Path $projectRoot "apps\launcher\src-tauri\target\release\WebView2Loader.dll"),
  (Join-Path $projectRoot "apps\launcher\src-tauri\target\debug\WebView2Loader.dll"),
  (Join-Path $buildRoot "apps\launcher\src-tauri\target\release\WebView2Loader.dll")
)
foreach ($s in $dllSources) {
  if (Test-Path $s) {
    Copy-Item $s (Join-Path $resDir "WebView2Loader.dll") -Force
    break
  }
}
if (-not (Test-Path (Join-Path $resDir "WebView2Loader.dll"))) {
  Write-Host "警告：未找到 WebView2Loader.dll（需先执行过一次 cargo build）" -ForegroundColor Yellow
}

# 1) 准备无空格构建目录
Write-Host "准备无空格构建目录: $buildRoot" -ForegroundColor Cyan
if (Test-Path $buildRoot) { Remove-Item $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Force "$buildRoot\apps\launcher" | Out-Null
New-Item -ItemType Directory -Force "$buildRoot\apps\shell-web" | Out-Null
robocopy "$projectRoot\apps\launcher\src-tauri" "$buildRoot\apps\launcher\src-tauri" /E /XD target /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy "$projectRoot\apps\shell-web\dist" "$buildRoot\apps\shell-web\dist" /E /NFL /NDL /NJH /NJS /NP | Out-Null

# 2) 定位 MinGW（优先 MSYS2 现代 binutils，回退旧 MinGW）
$mingwDirs = @(
  "C:\msys64\msys64\mingw64\bin",
  "D:\mingw64\bin"
)
$mingw = $mingwDirs | Where-Object { Test-Path (Join-Path $_ "gcc.exe") } | Select-Object -First 1
if (-not $mingw) { Write-Host "未找到 MinGW (gcc.exe)" -ForegroundColor Red; exit 1 }
Write-Host "使用 MinGW: $mingw" -ForegroundColor Cyan

$env:Path = "$mingw;$env:USERPROFILE\.cargo\bin;$env:Path"
$env:CARGO_TARGET_DIR = $targetDir

# 3) 构建
Write-Host "cargo build ..." -ForegroundColor Cyan
Set-Location "$buildRoot\apps\launcher\src-tauri"
cargo build
if ($LASTEXITCODE -ne 0) { Write-Host "构建失败" -ForegroundColor Red; exit $LASTEXITCODE }

$exe = Join-Path $targetDir "debug\godsh.exe"
if (Test-Path $exe) {
  Write-Host "产物: $exe ($([math]::Round((Get-Item $exe).Length/1MB,1)) MB)" -ForegroundColor Green
} else {
  Write-Host "未找到产物" -ForegroundColor Red
}

# 4) 把新生成的 WebView2Loader.dll 复制回 resources（供后续安装器打包使用）
$newDll = Join-Path $targetDir "debug\WebView2Loader.dll"
if (Test-Path $newDll) {
  Copy-Item $newDll (Join-Path $projectRoot "apps\launcher\src-tauri\resources\WebView2Loader.dll") -Force
  Write-Host "WebView2Loader.dll 已同步到 resources" -ForegroundColor Gray
}
