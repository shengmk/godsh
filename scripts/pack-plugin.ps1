# 将本地插件目录打包为 dsh Bundle（npm pack）
# 用法: pwsh -File scripts/pack-plugin.ps1 hello-world
param([Parameter(Mandatory=$true)][string]$PluginName)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $root "plugins\$PluginName"

if (-not (Test-Path $pluginDir)) {
    Write-Host "插件目录不存在: $pluginDir" -ForegroundColor Red
    exit 1
}

Set-Location $pluginDir
if (Test-Path "$pluginDir\package.json") {
    Write-Host "打包插件: $PluginName" -ForegroundColor Cyan
    pnpm pack
} else {
    Write-Host "缺少 package.json，无法打包" -ForegroundColor Red
    exit 1
}
