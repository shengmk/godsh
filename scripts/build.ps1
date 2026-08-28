# dsh Launcher 构建/校验脚本
# 当前阶段执行 TypeScript 类型检查（产物打包将在 UI 迭代中补充）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root\node_modules")) {
    pnpm install
}

Write-Host "TypeScript 类型检查..." -ForegroundColor Cyan
pnpm typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Host "类型检查失败" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "类型检查通过" -ForegroundColor Green
