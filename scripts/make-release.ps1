# godsh 发布打包脚本（本地 / GitHub Actions 双环境自适应）
# 流程：打包后端 → 构建前端(tauri) → tauri build（嵌入前端）→ 打 ZIP + 复制安装器 → SHA256
# 用法: pwsh -File scripts/make-release.ps1 [-Version x.y.z]
#       -Version 省略时自动取唯一真源（根 package.json 的 version）。
param(
  [string]$Version = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force $releaseDir | Out-Null

# 版本号兜底：从唯一真源读取，避免脚本内再写死一个会漂移的默认值
if (-not $Version) {
  $Version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
  Write-Host "未指定 -Version，已从 package.json 读取: $Version" -ForegroundColor Gray
}
$tauri = Join-Path $root "node_modules\@tauri-apps\cli\tauri.js"

Write-Host "==> 0/5 环境检测" -ForegroundColor Cyan
Write-Host "root: $root"
Write-Host "CI:   $env:CI"
# PATH 自适应：合并 npm 全局 / rustup 工具链 / msys2 / cargo（存在才加，缺失不报错）
$candidates = @(
  "$env:APPDATA\npm",
  "C:\Users\Shengmingkai\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin",
  "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin",
  "C:\Users\Shengmingkai\.cargo\bin",
  "$env:USERPROFILE\.cargo\bin",
  "D:\mingw64\bin",
  "C:\msys64\mingw64\bin",
  "C:\msys64\msys64\mingw64\bin",
  "C:\x86_64-8.1.0-release-posix-seh-rt_v6-rev0\mingw64\bin"
)
if (Test-Path "C:\Users\Shengmingkai\.rustup") {
  $env:RUSTUP_HOME = "C:\Users\Shengmingkai\.rustup"
  $env:CARGO_HOME = "C:\Users\Shengmingkai\.cargo"
}
$env:Path = ((($candidates | Where-Object { Test-Path $_ }) -join ';') + ';' + $env:Path)
Write-Host "cargo: $(cargo --version 2>&1) / rustc: $(rustc --version 2>&1)"

if (-not $SkipBuild) {
  # 1) 前置构建：后端单文件 + 前端（tauri 模式）
  Write-Host "==> 1/5 打包后端 + 构建前端..." -ForegroundColor Cyan
  Set-Location $root
  # 必须走 scripts/build-server.mjs，不能在这里裸调 esbuild：
  # 该脚本会把根 package.json 的 version 经 esbuild --define 注入 __GODSH_VERSION__。
  # 裸调 esbuild 会漏掉注入，产物在打包路径下读不到根 package.json，
  # 于是 /api/health 自报 `0.0.0-dev`（?02 实测：布局 A 复现，布局 C 修复后为 0.6.1）。
  node scripts/build-server.mjs
  if ($LASTEXITCODE -ne 0) { Write-Host "后端打包失败" -ForegroundColor Red; exit 1 }
  node apps/shell-web/node_modules/vite/bin/vite.js build apps/shell-web --mode tauri
  if ($LASTEXITCODE -ne 0) { Write-Host "前端构建失败" -ForegroundColor Red; exit 1 }

  # 2) 填充 resources（server.mjs + templates + 前端静态资源）
  $resDir = Join-Path $root "apps\launcher\src-tauri\resources"
  New-Item -ItemType Directory -Force $resDir | Out-Null
  Copy-Item (Join-Path $root "apps\launcher\dist\server.mjs") (Join-Path $resDir "server.mjs") -Force
  if (Test-Path (Join-Path $root "kernels\templates")) {
    robocopy (Join-Path $root "kernels\templates") (Join-Path $resDir "templates") /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  # 前端静态资源也必须随包发布：node 后端在「与 server.mjs 同级」处找 shell-web/
  # （见 apps/launcher/src/server.ts 的 serveStatic 兜底链）。
  # 桌面窗口用的是编译进 exe 的 frontendDist，所以缺了它 GUI 仍正常，
  # 但用浏览器打开 http://127.0.0.1:<port>/ 只会看到「前端尚未构建」占位文本（?02 实测）。
  $resShell = Join-Path $resDir "shell-web"
  if (Test-Path $resShell) { Remove-Item $resShell -Recurse -Force }
  $shellDist = Join-Path $root "apps\shell-web\dist"
  if (Test-Path $shellDist) {
    robocopy $shellDist $resShell /E /NFL /NDL /NJH /NJS /NP | Out-Null
  } else {
    Write-Host "警告: 未找到 $shellDist，打包版将无法用浏览器打开界面" -ForegroundColor Yellow
  }

  # 3) tauri build（内嵌前端 + 官方 NSIS 安装器；beforeBuildCommand 会再次构建前端，幂等无害）
  Write-Host "==> 2/5 tauri build（内嵌前端 + 官方 NSIS 安装器）..." -ForegroundColor Cyan
  Set-Location (Join-Path $root "apps\launcher")
  node $tauri build --ci --no-sign --bundles nsis
  if ($LASTEXITCODE -ne 0) { Write-Host "tauri build 失败" -ForegroundColor Red; exit 1 }
} else {
  Write-Host "==> 1/5 & 2/5 跳过重复构建（直接收集已完成的产物）..." -ForegroundColor Yellow
}

# 4) 收集产物
Write-Host "==> 3/5 收集产物..." -ForegroundColor Cyan
$srcRelease = Join-Path $root "apps\launcher\src-tauri\target\release"
$exe = Join-Path $srcRelease "godsh.exe"
if (-not (Test-Path $exe)) { Write-Host "缺少 godsh.exe" -ForegroundColor Red; exit 1 }

$stage = Join-Path $env:TEMP "godsh-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $exe $stage -Force
Copy-Item $exe (Join-Path $releaseDir "godsh.exe") -Force

$dllSrc = if (Test-Path (Join-Path $srcRelease "WebView2Loader.dll")) {
  Join-Path $srcRelease "WebView2Loader.dll"
} elseif (Test-Path (Join-Path $root "release\WebView2Loader.dll")) {
  Join-Path $root "release\WebView2Loader.dll"
} else {
  $found = Get-ChildItem (Join-Path $srcRelease "build") -Filter "WebView2Loader.dll" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if ($found) { $found.FullName } else { $null }
}
if ($dllSrc) {
  Copy-Item $dllSrc $stage -Force
  $dllDst1 = Join-Path $srcRelease "WebView2Loader.dll"
  if ((Resolve-Path $dllSrc -ErrorAction SilentlyContinue).Path -ne (Resolve-Path $dllDst1 -ErrorAction SilentlyContinue).Path) {
    Copy-Item $dllSrc $dllDst1 -Force
  }
  $dllDst2 = Join-Path $releaseDir "WebView2Loader.dll"
  if ((Resolve-Path $dllSrc -ErrorAction SilentlyContinue).Path -ne (Resolve-Path $dllDst2 -ErrorAction SilentlyContinue).Path) {
    Copy-Item $dllSrc $dllDst2 -Force
  }
}

if (Test-Path (Join-Path $srcRelease "resources")) {
  robocopy (Join-Path $srcRelease "resources") (Join-Path $stage "resources") /E /NFL /NDL /NJH /NJS /NP | Out-Null
} elseif (Test-Path (Join-Path $root "apps\launcher\src-tauri\resources")) {
  robocopy (Join-Path $root "apps\launcher\src-tauri\resources") (Join-Path $stage "resources") /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
Remove-Item (Join-Path $stage "resources\WebView2Loader.dll") -Force -ErrorAction SilentlyContinue

# 复制一份未压缩的便携目录
$unpackedDir = Join-Path $releaseDir "godsh-$Version-x64"
if (Test-Path $unpackedDir) { Remove-Item $unpackedDir -Recurse -Force }
robocopy $stage $unpackedDir /E /NFL /NDL /NJH /NJS /NP | Out-Null

# 5) ZIP 便携版 + 官方 NSIS/MSI 安装器改名复制
Write-Host "==> 4/5 生成 ZIP 与安装器..." -ForegroundColor Cyan
$zip = Join-Path $releaseDir "godsh-$Version-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$bundleDir = Join-Path $srcRelease "bundle"
if (Test-Path $bundleDir) {
  # 只取与**本轮 $Version 匹配**的安装器，而不是把 bundle 下所有安装器都拷成同一个名字。
  #
  # 为什么必须这样改（2026-09-11 实测）：tauri 的 bundle/nsis 会累积历史产物，本机当时躺着 9 个
  # （0.5.2 / 0.5.3 / 0.5.5 / 0.6.0 / 0.6.1 / 0.6.2 / 0.6.3 / 0.6.4 / 本轮）。旧实现按 `*.exe,*.msi`
  # 全量遍历、循环内一律拷成 `godsh-$Version-x64-setup.exe`，于是**谁最后被枚举到谁就赢** ——
  # 本轮的 0.6.5 只是恰好按文件名升序排在最后才胜出（日志里那行"安装器:"重复打印了 9 次）。
  # 一旦枚举顺序变化，就会把上一版的安装包当成新版发布出去，正是"自报旧版本"那一类事故。
  #
  # 因此这里改为：按版本号筛出候选 → 数量不对就**直接失败**（宁可发不出去，也不能发错包）。
  $allBundleArtifacts = Get-ChildItem $bundleDir -Recurse -Include *.exe,*.msi -File
  $matched = @($allBundleArtifacts | Where-Object { $_.Name -like "*_$Version`_*" })
  $setups = @($matched | Where-Object { $_.Extension -eq '.exe' -and $_.Name -match 'setup' })
  $msis = @($matched | Where-Object { $_.Extension -eq '.msi' })

  if ($setups.Count -ne 1) {
    $found = ($matched | ForEach-Object { '    ' + $_.Name }) -join "`n"
    throw "期望恰好 1 个与 $Version 匹配的 setup 安装器，实际 $($setups.Count) 个。候选：`n$found`n（bundle 目录：$bundleDir）"
  }
  $setupDest = Join-Path $releaseDir "godsh-$Version-x64-setup.exe"
  Copy-Item $setups[0].FullName $setupDest -Force
  Write-Host "  安装器: godsh-$Version-x64-setup.exe  ← $($setups[0].Name)"

  if ($msis.Count -gt 1) {
    throw "找到 $($msis.Count) 个与 $Version 匹配的 msi，无法确定该用哪个"
  }
  if ($msis.Count -eq 1) {
    Copy-Item $msis[0].FullName (Join-Path $releaseDir "godsh-$Version-x64.msi") -Force
    Write-Host "  安装器: godsh-$Version-x64.msi  ← $($msis[0].Name)"
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
