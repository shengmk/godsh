# godsh 隔离环境冒烟测试运行器（供 pnpm test:smoke 调用）
# 运行不依赖真实 DSH 安装、使用临时 DSH_HOME/数据目录的回归冒烟脚本（scripts/smoke/）。
# 注意：_smoke.ps1 / _smoke-p1.ps1 / _smoke-p3.ps1 / _smoke-unified.ps1
# 依赖真实 dsh 启动或历史 _extracted 产物，不在自动化范围内。
param(
    [int]$PerScriptTimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$smokeDir = Join-Path $root 'scripts\smoke'
$scripts = @('_smoke-v021.ps1', '_smoke-a-group.ps1', '_smoke-c-group.ps1', '_smoke-cross-drag.ps1', '_smoke-alloc.ps1', '_smoke-p2.ps1')
$failed = $false

# 预清理：杀掉可能残留的测试 server（避免端口被占导致误判）
$ports = @(48231, 48329, 48321, 48461, 47896, 47902)
$lines = netstat -ano -p tcp | Select-String 'LISTENING'
foreach ($line in $lines) {
    foreach ($port in $ports) {
        if ($line.Line -match ":$port\s") {
            $procId = ($line.Line.Trim() -split '\s+')[-1]
            if ($procId -match '^\d+$') {
                try { Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue } catch {}
                Write-Host "已清理端口 $port 的残留进程 $procId" -ForegroundColor Yellow
            }
        }
    }
}
Start-Sleep -Milliseconds 800

foreach ($name in $scripts) {
    $path = Join-Path $smokeDir $name
    Write-Host "==== 运行 $name ====" -ForegroundColor Cyan
    # 用 Start-Process -Wait 运行子脚本，输出重定向到临时文件（避免嵌套 powershell 管道交互问题）
    $outFile = Join-Path $env:TEMP "dshl-smoke-$name.out.txt"
    $errFile = Join-Path $env:TEMP "dshl-smoke-$name.err.txt"
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath 'powershell' -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $path) `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit($PerScriptTimeoutSec * 1000)) {
        Write-Host "✘ $name 超时（${PerScriptTimeoutSec}s），强制终止" -ForegroundColor Red
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $failed = $true
        continue
    }
    $tail = @()
    if (Test-Path $outFile) { $tail = Get-Content $outFile | Select-Object -Last 3 }
    $tail
    $lastLine = ($tail | Select-Object -Last 1) -join ''
    if ($lastLine -match '全部通过') {
        Write-Host "✔ $name 通过" -ForegroundColor Green
    } else {
        Write-Host "✘ $name 存在失败（exit=$($p.ExitCode)）" -ForegroundColor Red
        if (Test-Path $errFile) { Get-Content $errFile | Select-Object -Last 4 }
        $failed = $true
    }
    # 延迟清理临时文件（子进程句柄可能尚未释放）
    Start-Sleep -Milliseconds 200
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
}
if ($failed) {
    Write-Host '== 冒烟回归存在失败 ==' -ForegroundColor Red
    exit 1
}
Write-Host '== 全部冒烟回归通过 ==' -ForegroundColor Green
exit 0
