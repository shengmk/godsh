# dsh Launcher 开发脚本
# 用法: pwsh -File scripts/dev.ps1 [launcher 参数...]
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root\node_modules")) {
    Write-Host "首次运行：安装依赖..." -ForegroundColor Yellow
    pnpm install
}

Write-Host "启动 dsh Launcher CLI..." -ForegroundColor Cyan
pnpm launcher @args
