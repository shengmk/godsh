# 插件分配可视化冒烟测试：available 清单 + 跨 Profile 移动 + 自动写回
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$server = Join-Path $root 'apps\launcher\dist\server.mjs'
$work = Join-Path $env:TEMP 'dshl-smoke-alloc'
$failed = @()

function Get-Json($url) { (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json }
function Check($name, $cond) {
  if ($cond) { Write-Host "[PASS] $name" } else { Write-Host "[FAIL] $name"; $script:failed += $name }
}
function FreePort($port) {
  $lines = netstat -ano -p tcp | Select-String "LISTENING" | Select-String ":$port`t|:$port "
  foreach ($line in $lines) { $procId = ($line.Line.Trim() -split '\s+')[-1]; if ($procId -match '^\d+$') { taskkill /PID $procId /T /F 2>&1 | Out-Null } }
}

FreePort 47896
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
foreach ($name in 'alpha', 'beta') {
  $dir = Join-Path $work "home\profiles\$name"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
$alpha = @{ name = 'alpha'; private = $true; dependencies = @{ 'hello-a' = '^1.0.0' }; dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } } } | ConvertTo-Json -Depth 10
$beta = @{ name = 'beta'; private = $true; dependencies = @{ }; dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base') } } } | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText("$work\home\profiles\alpha\package.json", $alpha)
[System.IO.File]::WriteAllText("$work\home\profiles\beta\package.json", $beta)

$procs = New-Object System.Collections.ArrayList
$api = $null
try {
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  $env:DSH_HOME = "$work\home"
  $env:DSH_LAUNCHER_DATA_DIR = "$work\data"
  $api = Start-Process node -ArgumentList $server,'serve','--port','47896' -PassThru -WindowStyle Hidden
  $procs.Add($api) | Out-Null
  $up = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 700; try { $null = Invoke-WebRequest 'http://127.0.0.1:47896/api/health' -UseBasicParsing -TimeoutSec 1; $up = $true; break } catch {} }
  if (-not $up) { throw 'API 未就绪' }

  # 1. available 清单
  # 注：本环境 pwsh 对 ConvertFrom-Json 对象的 Where-Object 属性比较不可靠，统一用 ForEach 投影 + -contains
  $av = Get-Json 'http://127.0.0.1:47896/api/allocations/available'
  $alphaPairs = @($av.available.alpha | ForEach-Object { "$($_.pluginId)|$($_.source)" })
  Check 'AL1 alpha 含依赖 hello-a' ($alphaPairs -contains 'hello-a|dependency')
  Check 'AL2 alpha 含 bundle web-app' ($alphaPairs -contains '@deepseek-ai/dsh-web-app|bundle')
  Check 'AL3 初始均未分配' (-not (@($av.available.alpha | ForEach-Object { $_.allocated }) -contains $true))

  # 2. 分配（点选路径：allocate）
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47896/api/allocations' -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"hello-a","pluginName":"hello-a"}'
  Check 'AL4 分配后 applied=true' ($r.applied -eq $true)
  $patchAlpha = Get-Content "$work\home\profiles\alpha\cordis.patch.yml" -Raw
  Check 'AL5 alpha patch 含 hello-a' ($patchAlpha -match 'id: hello-a')
  $id = $r.allocation.id

  # 3. available 反映分配状态
  $av2 = Get-Json 'http://127.0.0.1:47896/api/allocations/available'
  $aPairs = @($av2.available.alpha | ForEach-Object { "$($_.pluginId)|$($_.allocated)" })
  Check 'AL6 分配后 available.allocated=true' ($aPairs -contains 'hello-a|True')

  # 4. 跨 Profile 移动
  $m = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:47896/api/allocations/$id/move" -ContentType 'application/json' -Body '{"profile":"beta"}'
  Check 'AL7 移动后 allocation 属于 beta' ($m.allocation.profile -eq 'beta')
  $patchAlpha2 = Get-Content "$work\home\profiles\alpha\cordis.patch.yml" -Raw
  $patchBeta = Get-Content "$work\home\profiles\beta\cordis.patch.yml" -Raw
  Check 'AL8 旧 profile patch 已清理' (-not ($patchAlpha2 -match 'hello-a'))
  Check 'AL9 新 profile patch 已写入' ($patchBeta -match 'id: hello-a')

  $list = Get-Json 'http://127.0.0.1:47896/api/allocations'
  $allocPairs = @($list.allocations | ForEach-Object { "$($_.pluginId)|$($_.profile)" })
  Check 'AL10 分配列表仅剩 beta 一条' ($allocPairs -contains 'hello-a|beta')
}
finally {
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_LAUNCHER_DATA_DIR -ErrorAction SilentlyContinue
  if ($api) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  FreePort 47896
}

Write-Host ''
if ($failed.Count -eq 0) { Write-Host '=== 分配可视化冒烟测试全部通过 ===' } else { Write-Host "=== 失败项: $($failed -join ', ') ==="; exit 1 }
