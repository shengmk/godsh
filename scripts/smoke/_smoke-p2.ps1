# P2 冒烟测试：启动失败诊断 + 内核实例日志 + 数据备份导出/导入
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$server = Join-Path $root 'apps\launcher\dist\server.mjs'
$work = Join-Path $env:TEMP 'dshl-smoke-p2'
$failed = @()

function Get-Json($url) { (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json }
function Check($name, $cond) {
  if ($cond) { Write-Host "[PASS] $name" } else { Write-Host "[FAIL] $name"; $script:failed += $name }
}
function FreePort($port) {
  $lines = netstat -ano -p tcp | Select-String "LISTENING" | Select-String ":$port`t|:$port "
  foreach ($line in $lines) { $procId = ($line.Line.Trim() -split '\s+')[-1]; if ($procId -match '^\d+$') { taskkill /PID $procId /T /F 2>&1 | Out-Null } }
}

FreePort 47902, 39250, 39999
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
foreach ($name in 'demo', 'broken') {
  $dir = Join-Path $work "home\profiles\$name"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
$demo = @{ name = 'demo'; private = $true; dependencies = @{}; dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } } } | ConvertTo-Json -Depth 10
$broken = @{ name = 'broken'; private = $true; dependencies = @{}; dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', 'no-such-pkg-xyz') } } } | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText("$work\home\profiles\demo\package.json", $demo)
[System.IO.File]::WriteAllText("$work\home\profiles\broken\package.json", $broken)

$procs = New-Object System.Collections.ArrayList
$api = $null
try {
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  $env:DSH_HOME = "$work\home"
  $env:DSH_LAUNCHER_DATA_DIR = "$work\data"
  $api = Start-Process node -ArgumentList $server,'serve','--port','47902' -PassThru -WindowStyle Hidden
  $procs.Add($api) | Out-Null
  $up = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 700; try { $null = Invoke-WebRequest 'http://127.0.0.1:47902/api/health' -UseBasicParsing -TimeoutSec 1; $up = $true; break } catch {} }
  if (-not $up) { throw 'API 未就绪' }

  # 1. 启动失败诊断：broken profile（bundle 不存在 → dsh 进程快速退出）
  $null = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47902/api/profiles/broken/start' -ContentType 'application/json' -Body '{"port":39250}'
  $st = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { $st = Get-Json 'http://127.0.0.1:47902/api/profiles/broken/status'; if ($st.error) { break } } catch {}
  }
  Check 'D1 失败状态 error 已标记' ($null -ne $st -and $null -ne $st.error)
  Check 'D2 失败后 running=false' ($st.running -eq $false)
  $log = (Get-Json 'http://127.0.0.1:47902/api/profiles/broken/log').log
  Check 'D3 日志非空（含失败原因）' ($log.Length -gt 0)
  $profiles = Get-Json 'http://127.0.0.1:47902/api/profiles'
  $brokenView = $profiles.profiles | ForEach-Object { if ($_.name -eq 'broken') { $_ } } | Select-Object -First 1
  Check 'D4 profileView 带 procError' ($null -ne $brokenView -and $null -ne $brokenView.procError)

  # 2. 内核实例日志：创建实例 + 预置日志文件 → 读取
  $k = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47902/api/kernels' -ContentType 'application/json' -Body '{"templateId":"web-default","profile":"demo","port":39999,"name":"klog-test"}'
  $kid = $k.instance.id
  New-Item -ItemType Directory -Path "$work\data\logs" -Force | Out-Null
  [System.IO.File]::WriteAllText("$work\data\logs\dsh-demo-39999.log", "MARKER-KERNEL-LOG ok`nsecond line`n")
  $klog = (Get-Json "http://127.0.0.1:47902/api/kernels/$kid/log").log
  Check 'K1 内核日志读取成功' ($klog -match 'MARKER-KERNEL-LOG')

  # 3. 数据备份导出/导入
  $b1 = Get-Json 'http://127.0.0.1:47902/api/backup'
  Check 'B1 备份含 config/kernels/allocations/unifiedKernel' ($null -ne $b1.config -and $null -ne $b1.kernels -and $null -ne $b1.allocations -and $null -ne $b1.unifiedKernel)
  # 修改数据
  $null = Invoke-RestMethod -Method Put -Uri 'http://127.0.0.1:47902/api/settings' -ContentType 'application/json' -Body '{"pluginMarket":{"enabled":true,"indexUrl":"http://changed.test/x.json"}}'
  $null = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47902/api/allocations' -ContentType 'application/json' -Body '{"profile":"demo","pluginId":"hello-a"}'
  $before = (Get-Json 'http://127.0.0.1:47902/api/allocations').allocations.Count
  Check 'B2 修改后分配数>0' ($before -gt 0)
  # 导入旧备份 → 恢复
  $restoreBody = @{ backup = $b1 } | ConvertTo-Json -Depth 30
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47902/api/backup/restore' -ContentType 'application/json' -Body $restoreBody
  Check 'B3 restore 成功' ($r.ok -eq $true)
  $after = (Get-Json 'http://127.0.0.1:47902/api/allocations').allocations.Count
  Check 'B4 分配已恢复为空' ($after -eq 0)
  $cfgAfter = (Get-Json 'http://127.0.0.1:47902/api/settings').config
  Check 'B5 市场 URL 已恢复' ($cfgAfter.pluginMarket.indexUrl -eq 'https://awesome-dsh-plugin.com/plugins.json')
  # 清理内核实例
  $null = Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:47902/api/kernels/$kid"
}
finally {
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_LAUNCHER_DATA_DIR -ErrorAction SilentlyContinue
  if ($api) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  FreePort 47902, 39250, 39999
}

Write-Host ''
if ($failed.Count -eq 0) { Write-Host '=== P2 体验补强冒烟测试全部通过 ===' } else { Write-Host "=== 失败项: $($failed -join ', ') ==="; exit 1 }
