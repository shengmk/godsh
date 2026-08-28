# 跨环境拖拽冒烟：plugin_bag → desktop 移动 dsh-memory（用户核心场景）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$work = Join-Path $env:TEMP ("dshl-cross-smoke-" + [guid]::NewGuid().ToString('N'))
function Write-JsonNoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}
$pb = Join-Path $work 'home\profiles\plugin_bag'
New-Item -ItemType Directory -Force $pb | Out-Null
Write-JsonNoBom (Join-Path $pb 'package.json') '{ "name": "plugin_bag", "dependencies": { "dsh-memory": "^1.0.0", "dsh-market": "^1.0.0" }, "dsh": { "profile": { "bundles": [] } } }'
Write-JsonNoBom (Join-Path $pb 'cordis.patch.yml') "- insert:`n    - id: dsh-memory`n"
$dp = Join-Path $work 'home\profiles\desktop'
New-Item -ItemType Directory -Force $dp | Out-Null
Write-JsonNoBom (Join-Path $dp 'package.json') '{ "name": "desktop", "dependencies": { "dsh-memory": "^1.0.0" }, "dsh": { "profile": { "bundles": [] } } }'
Write-JsonNoBom (Join-Path $dp 'cordis.patch.yml') "[]"

$env:DSH_HOME = Join-Path $work 'home'
$env:DSH_LAUNCHER_DATA_DIR = Join-Path $work 'data'
$port = 48461
$server = Start-Process -FilePath 'node' -ArgumentList @("$root\apps\launcher\dist\server.mjs", 'serve', '--port', "$port") -PassThru -WindowStyle Hidden
$ok = $true
function Check($name, $cond, $extra) {
  if ($cond) { Write-Output "PASS  $name" }
  else { Write-Output "FAIL  $name  $extra"; $script:ok = $false }
}
try {
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  Check '服务启动' $ready ''
  if (-not $ready) { throw 'server not ready' }

  # 1) plugin_bag 分配 dsh-memory（模拟已分配卡片）
  $a1 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"plugin_bag","pluginId":"dsh-memory"}' -TimeoutSec 5
  Check 'plugin_bag 分配 dsh-memory' ($null -ne $a1.allocation.id) ($a1 | ConvertTo-Json -Compress)

  # 2) 跨环境移动（前端 handleCrossProfileDrop 调用的接口）
  $mv = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/$($a1.allocation.id)/move" -Method Post -ContentType 'application/json' -Body '{"profile":"desktop"}' -TimeoutSec 5
  Check 'dsh-memory 移动到 desktop' ($mv.allocation.profile -eq 'desktop') ($mv | ConvertTo-Json -Compress)

  # 3) 两个环境 patch 写回正确
  $pbPatch = Get-Content (Join-Path $pb 'cordis.patch.yml') -Raw -ErrorAction SilentlyContinue
  $dpPatch = Get-Content (Join-Path $dp 'cordis.patch.yml') -Raw -ErrorAction SilentlyContinue
  if ($null -eq $pbPatch) { $pbPatch = '' }
  if ($null -eq $dpPatch) { $dpPatch = '' }
  Check 'plugin_bag patch 移除 dsh-memory' ($pbPatch -notmatch 'dsh-memory') $pbPatch
  Check 'desktop patch 加入 dsh-memory' ($dpPatch -match 'dsh-memory') $dpPatch

  # 4) 前端判断所需数据：desktop 已安装 dsh-memory（可用插件跨环境分配可行）
  $pl = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/desktop/plugins" -TimeoutSec 5
  Check 'desktop 已安装 dsh-memory' ($pl.installedNames -contains 'dsh-memory') ($pl.installedNames -join ',')

  # 5) 最终 desktop 分配
  $al = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -TimeoutSec 5
  $desktopAllocs = @($al.allocations | Where-Object { $_.profile -eq 'desktop' } | ForEach-Object { $_.pluginId })
  Check 'desktop 分配含 dsh-memory' ($desktopAllocs -contains 'dsh-memory') ($desktopAllocs -join ',')
} catch {
  Write-Output "FAIL  异常: $_"
  $ok = $false
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  try { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } catch {}
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_LAUNCHER_DATA_DIR -ErrorAction SilentlyContinue
}
if ($ok) { Write-Output '== 跨环境拖拽冒烟全部通过 ==' } else { Write-Output '== 跨环境拖拽冒烟存在失败 ==' }
exit ($(if ($ok) { 0 } else { 1 }))
