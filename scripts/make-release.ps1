# godsh 发布打包脚本
# 流程：打包后端 → 构建前端(tauri) → tauri build（嵌入前端 + custom-protocol）→ 打 ZIP + NSIS 安装器
# 关键：
#   - 必须用 `tauri build` 编译（普通 cargo build 会用 devUrl 加载 5173，导致界面 404）
#   - WebView2Loader.dll 放在 exe 旁（GNU 工具链下 WebView 初始化必需）
# 用法: pwsh -File scripts/make-release.ps1 [-Version 0.1.0]
param([string]$Version = "0.1.0")

# 不用 Stop：pnpm 的 .ps1 包装会把命令回显写到 stderr，Stop 会误判为终止错误；
# 脚本已用 $LASTEXITCODE 显式检查各步骤结果。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "release"
$buildRoot = Join-Path $env:USERPROFILE "godsh"
$tauri = Join-Path $root "node_modules\@tauri-apps\cli\tauri.js"

# 0) 前置构建：后端单文件 + 前端（tauri 模式，API 指向 4780）
Write-Host "1/6 打包后端 + 构建前端..." -ForegroundColor Cyan
Set-Location $root
pnpm build:server
if ($LASTEXITCODE -ne 0) { Write-Host "后端打包失败" -ForegroundColor Red; exit 1 }
pnpm --filter @godsh/shell-web build:tauri
if ($LASTEXITCODE -ne 0) { Write-Host "前端构建失败" -ForegroundColor Red; exit 1 }

# 0.5) 填充 resources（server.mjs + templates；DLL 由 tauri build 生成后从 target 取）
$resDir = Join-Path $root "apps\launcher\src-tauri\resources"
New-Item -ItemType Directory -Force $resDir | Out-Null
Copy-Item (Join-Path $root "apps\launcher\dist\server.mjs") (Join-Path $resDir "server.mjs") -Force
robocopy (Join-Path $root "kernels\templates") (Join-Path $resDir "templates") /E /NFL /NDL /NJH /NJS /NP | Out-Null

# 1) 同步 src-tauri + 前端 dist 到无空格目录（GNU 工具链要求路径无空格）
Write-Host "2/6 同步到无空格目录..." -ForegroundColor Cyan
robocopy (Join-Path $root "apps\launcher\src-tauri") "$buildRoot\apps\launcher\src-tauri" /E /XD target /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $root "apps\shell-web\dist") "$buildRoot\apps\shell-web\dist" /E /NFL /NDL /NJH /NJS /NP | Out-Null
# beforeBuildCommand 置空（前端已手动构建，且无空格目录没有 pnpm workspace）；注意无 BOM 写入
$confPath = "$buildRoot\apps\launcher\src-tauri\tauri.conf.json"
$confContent = (Get-Content $confPath -Raw) -replace '"beforeBuildCommand"\s*:\s*"[^"]*"', '"beforeBuildCommand": ""'
[System.IO.File]::WriteAllText($confPath, $confContent, (New-Object System.Text.UTF8Encoding($false)))

# 2) tauri build（release + custom-protocol → 内嵌前端；不打包安装器）
Write-Host "3/6 tauri build（内嵌前端）..." -ForegroundColor Cyan
$env:Path = "C:\msys64\msys64\mingw64\bin;$env:USERPROFILE\.cargo\bin;$env:Path"
Set-Location "$buildRoot\apps\launcher"
node $tauri build --no-bundle --ci --no-sign
if ($LASTEXITCODE -ne 0) { Write-Host "tauri build 失败" -ForegroundColor Red; exit 1 }

# 3) 暂存：exe + WebView2Loader.dll（exe 旁）+ resources
Write-Host "4/6 暂存发布文件..." -ForegroundColor Cyan
$srcRelease = "$buildRoot\apps\launcher\src-tauri\target\release"
foreach ($f in @("godsh.exe", "WebView2Loader.dll")) {
    if (-not (Test-Path (Join-Path $srcRelease $f))) {
        Write-Host "缺少 $f，请检查 tauri build 产物" -ForegroundColor Red
        exit 1
    }
}
$stage = Join-Path $env:TEMP "godsh-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $srcRelease "godsh.exe") $stage -Force
Copy-Item (Join-Path $srcRelease "WebView2Loader.dll") $stage -Force
robocopy (Join-Path $srcRelease "resources") (Join-Path $stage "resources") /E /NFL /NDL /NJH /NJS /NP | Out-Null
Remove-Item (Join-Path $stage "resources\WebView2Loader.dll") -Force -ErrorAction SilentlyContinue

# 4) ZIP 便携版
Write-Host "5/6 生成 ZIP 与 NSIS 安装器..." -ForegroundColor Cyan
$zip = Join-Path $releaseDir "godsh-$Version-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

# 5) NSIS 安装器（DLL 安装到 exe 旁）
$makensis = "C:\Users\Shengmingkai\AppData\Local\tauri\NSIS\makensis.exe"
if (-not (Test-Path $makensis)) { Write-Host "未找到 makensis（先跑过一次 tauri build）" -ForegroundColor Red; exit 1 }
$setupOut = Join-Path $releaseDir "godsh-$Version-x64-setup.exe"
$nsi = Join-Path $stage "installer.nsi"
@"
Unicode true
!define APP_NAME "godsh"
!define VERSION "$Version"
Name "`${APP_NAME}"
OutFile "$setupOut"
InstallDir "`$LOCALAPPDATA\godsh"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "`$INSTDIR"
  File "godsh.exe"
  File "WebView2Loader.dll"
  File /r "resources"

  CreateDirectory "`$SMPROGRAMS\`${APP_NAME}"
  CreateShortCut "`$SMPROGRAMS\`${APP_NAME}\`${APP_NAME}.lnk" "`$INSTDIR\godsh.exe"
  CreateShortCut "`$DESKTOP\`${APP_NAME}.lnk" "`$INSTDIR\godsh.exe"

  WriteUninstaller "`$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "`$INSTDIR\godsh.exe"
  Delete "`$INSTDIR\WebView2Loader.dll"
  Delete "`$INSTDIR\uninstall.exe"
  RMDir /r "`$INSTDIR\resources"
  Delete "`$DESKTOP\`${APP_NAME}.lnk"
  RMDir /r "`$SMPROGRAMS\`${APP_NAME}"
  RMDir "`$INSTDIR"
SectionEnd
"@ | Set-Content $nsi -Encoding UTF8
& $makensis "/INPUTCHARSET" "UTF8" "/OUTPUTCHARSET" "UTF8" $nsi
if ($LASTEXITCODE -ne 0) { Write-Host "NSIS 打包失败" -ForegroundColor Red; exit 1 }

# 6) 校验和
Write-Host "6/6 生成校验和..." -ForegroundColor Cyan
$hashes = @()
foreach ($f in (Get-ChildItem $releaseDir -File | Where-Object { $_.Name -like "godsh-*" })) {
    $h = Get-FileHash $f.FullName -Algorithm SHA256
    $hashes += "$($h.Hash.ToLower())  $($f.Name)"
}
$hashes | Set-Content (Join-Path $releaseDir "SHA256SUMS.txt") -Encoding ASCII

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "完成。产物:" -ForegroundColor Green
Get-ChildItem $releaseDir | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize | Out-String
