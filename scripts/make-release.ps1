# godsh 发布打包脚本（本地 / GitHub Actions 双环境自适应）
# 流程：打包后端 → 构建前端(tauri) → tauri build（嵌入前端）→ 打 ZIP + 复制安装器 → SHA256
# 用法: pwsh -File scripts/make-release.ps1 [-Version 0.5.1]
param([string]$Version = "0.5.1")

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$tauri = Join-Path $root "node_modules\@tauri-apps\cli\tauri.js"

Write-Host "==> 0/5 环境检测" -ForegroundColor Cyan
Write-Host "root: $root"
Write-Host "CI:   $env:CI"
# PATH 自适应：合并 rustup 工具链 / msys2 / cargo（存在才加，缺失不报错）
$candidates = @(
  "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin",
  "$env:USERPROFILE\.cargo\bin",
  "C:\msys64\mingw64\bin",
  "C:\msys64\msys64\mingw64\bin",
  "D:\mingw64\bin",
  "C:\x86_64-8.1.0-release-posix-seh-rt_v6-rev0\mingw64\bin"
)
$env:Path = ((($candidates | Where-Object { Test-Path $_ }) -join ';') + ';' + $env:Path)
Write-Host "cargo: $(cargo --version 2>&1) / rustc: $(rustc --version 2>&1)"

# 1) 前置构建：后端单文件 + 前端（tauri 模式）
Write-Host "==> 1/5 打包后端 + 构建前端..." -ForegroundColor Cyan
Set-Location $root
pnpm build:server
if ($LASTEXITCODE -ne 0) { Write-Host "后端打包失败" -ForegroundColor Red; exit 1 }
pnpm --filter @godsh/shell-web build:tauri
if ($LASTEXITCODE -ne 0) { Write-Host "前端构建失败" -ForegroundColor Red; exit 1 }

# 2) 填充 resources（server.mjs + templates）
$resDir = Join-Path $root "apps\launcher\src-tauri\resources"
New-Item -ItemType Directory -Force $resDir | Out-Null
Copy-Item (Join-Path $root "apps\launcher\dist\server.mjs") (Join-Path $resDir "server.mjs") -Force
if (Test-Path (Join-Path $root "kernels\templates")) {
  robocopy (Join-Path $root "kernels\templates") (Join-Path $resDir "templates") /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

# 3) tauri build（内嵌前端 + 官方 NSIS 安装器；beforeBuildCommand 会再次构建前端，幂等无害）
Write-Host "==> 2/5 tauri build（内嵌前端 + 官方 NSIS 安装器）..." -ForegroundColor Cyan
Set-Location (Join-Path $root "apps\launcher")
node $tauri build --ci --no-sign --bundles nsis
if ($LASTEXITCODE -ne 0) { Write-Host "tauri build 失败" -ForegroundColor Red; exit 1 }

# 4) 收集产物
Write-Host "==> 3/5 收集产物..." -ForegroundColor Cyan
$srcRelease = Join-Path $root "apps\launcher\src-tauri\target\release"
$exe = Join-Path $srcRelease "godsh.exe"
if (-not (Test-Path $exe)) { Write-Host "缺少 godsh.exe" -ForegroundColor Red; exit 1 }

$stage = Join-Path $env:TEMP "godsh-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $exe $stage -Force
if (Test-Path (Join-Path $srcRelease "WebView2Loader.dll")) {
  Copy-Item (Join-Path $srcRelease "WebView2Loader.dll") $stage -Force
}
if (Test-Path (Join-Path $srcRelease "resources")) {
  robocopy (Join-Path $srcRelease "resources") (Join-Path $stage "resources") /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item (Join-Path $stage "resources\WebView2Loader.dll") -Force -ErrorAction SilentlyContinue
}

# 5) ZIP 便携版 + 官方 NSIS/MSI 安装器改名复制
Write-Host "==> 4/5 生成 ZIP 与安装器..." -ForegroundColor Cyan
$zip = Join-Path $releaseDir "godsh-$Version-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$bundleDir = Join-Path $srcRelease "bundle"
if (Test-Path $bundleDir) {
  Get-ChildItem $bundleDir -Recurse -Include *.exe,*.msi -File | ForEach-Object {
    $destName = if ($_.Name -match 'setup') { "godsh-$Version-x64-setup.exe" } else { "godsh-$Version-x64.msi" }
    Copy-Item $_.FullName (Join-Path $releaseDir $destName) -Force
    Write-Host "  安装器: $destName"
  }
} else {
  Write-Host "警告: 未找到 tauri bundle 目录，跳过安装器" -ForegroundColor Yellow
}

# 6) 校验和
Write-Host "==> 5/5 生成 SHA256..." -ForegroundColor Cyan
$hashes = @()
foreach ($f in (Get-ChildItem $releaseDir -File | Where-Object { $_.Name -like "godsh-*" })) {
  $h = Get-FileHash $f.FullName -Algorithm SHA256
  $hashes += "$($h.Hash.ToLower())  $($f.Name)"
}
$hashes | Set-Content (Join-Path $releaseDir "SHA256SUMS.txt") -Encoding ASCII

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "完成。产物:" -ForegroundColor Green
Get-ChildItem $releaseDir | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize | Out-String
