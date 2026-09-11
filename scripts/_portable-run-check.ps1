# godsh 便携版隔离实跑校验（临时 DSH_HOME / 临时数据目录）
# 用法: powershell -ExecutionPolicy Bypass -File scripts/_portable-run-check.ps1 -PortableDir <dir> [-PreferredPort 4781]
#
# 说明（本轮实测修正）：
#   Tauri 主进程**不读** DSH_LAUNCHER_PORT，它固定从 4780 起找第一个空闲端口
#   （lib.rs: find_free_port(4780)），并把该端口写进 <data>/logs/desktop-boot.log。
#   因此本脚本从 boot 日志 + 进程树监听端口**实测**出真实端口后再探活，
#   而不是假设某个端口；若 -PreferredPort 指定的端口恰好被选中，会额外打印这一点。
param(
    [Parameter(Mandatory=$true)][string]$PortableDir,
    [int]$PreferredPort = 4781,
    [int]$WaitSec = 60,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

# ---- 隔离硬断言：DSH_HOME 与数据目录必须落在 %TEMP% 之下 ----
$tempRoot = (Resolve-Path $env:TEMP).Path.TrimEnd('\')
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$testHome = Join-Path $tempRoot ("godsh-portcheck-home-" + $stamp)
$testData = Join-Path $tempRoot ("godsh-portcheck-data-" + $stamp)

foreach ($p in @($testHome, $testData)) {
    if (-not $p.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "隔离断言失败：$p 不在 TEMP（$tempRoot）之下"
    }
}
if ($testHome -ieq ($env:USERPROFILE.TrimEnd('\') + '\.dsh')) { throw '隔离断言失败：DSH_HOME 指向真实 ~/.dsh' }

New-Item -ItemType Directory -Force $testHome | Out-Null
New-Item -ItemType Directory -Force $testData | Out-Null

$exe = Join-Path $PortableDir 'godsh.exe'
if (-not (Test-Path $exe)) { throw "缺少便携版可执行文件：$exe" }
$server = Join-Path $PortableDir 'resources\server.mjs'
if (-not (Test-Path $server)) { throw "缺少 resources\server.mjs：$server" }

Write-Output "== 隔离参数 =="
Write-Output "便携目录   : $PortableDir"
Write-Output "DSH_HOME   : $testHome"
Write-Output "数据目录   : $testData"
Write-Output "期望端口   : $PreferredPort"

$env:DSH_HOME = $testHome
$env:DSH_LAUNCHER_DATA_DIR = $testData
$env:DSH_LAUNCHER_TEMPLATES_DIR = (Join-Path $PortableDir 'resources\templates')

$failed = @()
$port = $null
$nodeProcIds = @()

function Get-TreeListenPort {
    param([int]$RootPid)
    $all = @()
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    $seen = @{}
    while ($queue.Count -gt 0) {
        $cur = [int]$queue.Dequeue()
        if ($seen.ContainsKey($cur)) { continue }
        $seen[$cur] = $true
        $all += $cur
        foreach ($ch in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur" -ErrorAction SilentlyContinue)) {
            $queue.Enqueue([int]$ch.ProcessId)
        }
    }
    $conns = @()
    foreach ($procId in $all) {
        $c = Get-NetTCPConnection -State Listen -OwningProcess $procId -ErrorAction SilentlyContinue
        if ($c) { $conns += $c }
    }
    return @{ Pids = $all; Cons = $conns }
}

$proc = Start-Process -FilePath $exe -WorkingDirectory $PortableDir -PassThru
Write-Output "已启动 godsh.exe pid=$($proc.Id)（Tauri 主进程）"

try {
    $deadline = (Get-Date).AddSeconds($WaitSec)
    $health = $null
    $treePort = $null
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { throw "godsh.exe 提前退出，exit=$($proc.ExitCode)" }
        $info = Get-TreeListenPort -RootPid $proc.Id
        $cand = @($info.Cons | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -ge 4780 -and $_.LocalPort -le 4880 })
        if ($cand.Count -gt 0) {
            $treePort = $cand[0].LocalPort
            try {
                $h = Invoke-RestMethod -Uri "http://127.0.0.1:$treePort/api/health" -TimeoutSec 3
                if ($h.launcher) { $health = $h; $port = $treePort; break }
            } catch {}
        }
        Start-Sleep -Milliseconds 700
    }
    if (-not $health) { throw "等待 ${WaitSec}s 后仍未在进程树里探到可用的 /api/health" }

    $bootLog = Join-Path $testData 'logs\desktop-boot.log'
    if (Test-Path $bootLog) {
        Write-Output "== boot 日志 =="
        Get-Content $bootLog | ForEach-Object { Write-Output "  $_" }
    }

    $nodeProcIds = @($info.Pids | Where-Object { $_ -ne $proc.Id })
    Write-Output "[1] 实测端口 = $port （进程树 pid: $($info.Pids -join ', ')）"
    Write-Output "[1] /api/health launcher = $($health.launcher.name) $($health.launcher.version)"
    Write-Output "[1] DSH_HOME 自报 = $($health.dshHome)"
    if ($health.launcher.version -ne '0.6.6') { $failed += "launcher.version=$($health.launcher.version)，期望 0.6.6" }
    if ($health.dshHome -and -not ($health.dshHome -like "*Temp*")) { $failed += "后端自报的 DSH_HOME 不在 TEMP：$($health.dshHome)" }

    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 10 -UseBasicParsing
        Write-Output "[2] GET / -> $([int]$r.StatusCode) ($($r.RawContentLength) bytes)"
        if ([int]$r.StatusCode -ne 200) { $failed += "GET / 返回 $([int]$r.StatusCode)" }
    } catch { $failed += "GET / 失败: $($_.Exception.Message)"; Write-Output "[2] GET / -> ERR $($_.Exception.Message)" }

    try {
        $f = Invoke-WebRequest -Uri "http://127.0.0.1:$port/fonts/inter-var-latin.woff2" -TimeoutSec 10 -UseBasicParsing
        Write-Output "[3] GET /fonts/inter-var-latin.woff2 -> $([int]$f.StatusCode) ($($f.RawContentLength) bytes)"
        if ([int]$f.StatusCode -ne 200) { $failed += "字体资源返回 $([int]$f.StatusCode)" }
    } catch { $failed += "字体资源失败: $($_.Exception.Message)"; Write-Output "[3] 字体 -> ERR $($_.Exception.Message)" }

    Start-Sleep -Seconds 8
    $alive = -not $proc.HasExited
    $stillListening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    Write-Output "[4] 8s 后: 主进程存活=$alive 端口 $port 仍在监听=$stillListening"
    if (-not $alive) { $failed += '8s 后 godsh.exe 已退出' }
    if (-not $stillListening) { $failed += "8s 后端口 $port 不再监听" }
} finally {
    Write-Output "== 关闭 =="
    try { taskkill /PID $proc.Id /T /F | Out-Null } catch {}
    Start-Sleep -Seconds 3
    $left = if ($port) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue } else { $null }
    if ($left) {
        Write-Output "[5] 关闭后端口 $port 仍在监听 pid=$($left.OwningProcess)，二次清理"
        try { taskkill /PID $left.OwningProcess /T /F | Out-Null } catch {}
        Start-Sleep -Seconds 2
    }
    # 兜底：清掉本次启动遗留的任何 node 子进程
    foreach ($np in $nodeProcIds) {
        try { taskkill /PID $np /T /F 2>&1 | Out-Null } catch {}
    }
    Start-Sleep -Seconds 1
    $portsLeft = @()
    if ($port) {
        $l2 = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($l2) { $portsLeft += $port; $failed += "关闭后端口 $port 仍被监听（pid=$($l2.OwningProcess)）" }
    }
    Write-Output "[5] 结果: $(if ($portsLeft.Count -eq 0) { '端口已无监听' } else { '端口仍被监听: ' + ($portsLeft -join ',') })"
    if ($KeepTemp) {
        Write-Output "（保留临时目录用于分析）$testHome | $testData"
    } else {
        foreach ($p in @($testHome, $testData)) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($failed.Count -gt 0) {
    Write-Output "== 结果: 失败 =="
    $failed | ForEach-Object { Write-Output "  ✘ $_" }
    exit 1
}
Write-Output "== 结果: 全部通过 =="
exit 0
