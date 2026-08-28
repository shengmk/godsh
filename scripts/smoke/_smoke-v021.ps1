# dsh Launcher v0.2.2 新增功能冒烟测试（隔离环境，不碰真实 .dsh）
# 覆盖：合并轮询 /profiles/status、批量安装 /plugins/batch、可用插件 /allocations/available
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$work = Join-Path $env:TEMP ("dshl-smoke-" + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $work 'home'
$dataDir = Join-Path $work 'data'
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'profiles\alpha') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'profiles\beta') | Out-Null

# 无 BOM 写 JSON（scanner 用 JSON.parse，BOM 会导致解析失败）
function Write-JsonNoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# 两个假 Profile（alpha 有依赖+bundle，beta 为空）
Write-JsonNoBom (Join-Path $homeDir 'profiles\alpha\package.json') '{ "name": "alpha", "dependencies": { "@deepseek-ai/dsh-base": "^0.1.0", "@deepseek-ai/dsh-web-app": "^0.1.0" }, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }'
Write-JsonNoBom (Join-Path $homeDir 'profiles\beta\package.json') '{ "name": "beta", "dependencies": {}, "dsh": { "profile": { "bundles": [] } } }'

$port = 48231
$env:DSH_HOME = $homeDir
$env:DSH_LAUNCHER_DATA_DIR = $dataDir
$env:DSH_LAUNCHER_SKIP_NPM_UNINSTALL = '1'

$outLog = Join-Path $work 'server.out.log'
$errLog = Join-Path $work 'server.err.log'
$server = Start-Process -FilePath 'node' -ArgumentList @("$root\apps\launcher\dist\server.mjs", 'serve', '--port', "$port") -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$ok = $true
function Check($name, $cond, $extra) {
  if ($cond) { Write-Output "PASS  $name" }
  else { Write-Output "FAIL  $name  $extra"; $script:ok = $false }
}

try {
  # 等待服务就绪
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) {
    Write-Output "--- server stdout ---"; if (Test-Path $outLog) { Get-Content $outLog }
    Write-Output "--- server stderr ---"; if (Test-Path $errLog) { Get-Content $errLog }
    Write-Output "--- node processes ---"; Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime
  }
  Check '服务启动' $ready 'health 未就绪'
  if (-not $ready) { throw 'server not ready' }

  # 1) 合并轮询 /api/profiles/status?names=alpha,beta
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/status?names=alpha,beta"
  Check '合并轮询返回两环境' ($null -ne $st.statuses.alpha -and $null -ne $st.statuses.beta) ($st | ConvertTo-Json -Compress)
  Check '合并轮询 alpha 未运行' ($st.statuses.alpha.running -eq $false) ($st.statuses.alpha | ConvertTo-Json -Compress)
  Check '合并轮询含 url 字段' (($st.statuses.alpha.PSObject.Properties.Name -contains 'url')) ($st.statuses.alpha.url)

  # 空 names 返回空对象
  $st2 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/status"
  Check '合并轮询空 names 安全' ($null -ne $st2.statuses) ($st2 | ConvertTo-Json -Compress)

  # 2) 批量安装：空数组 → 400
  $bad = $false
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/alpha/plugins/batch" -Method Post -ContentType 'application/json' -Body '{"packages":[]}' -TimeoutSec 5 | Out-Null } catch { $bad = $true }
  Check '批量安装空数组 400' $bad '未拒绝'

  # 3) 批量安装：git 来源被策略拒绝（不真正执行 dsh），逐包返回结果
  $res = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/alpha/plugins/batch" -Method Post -ContentType 'application/json' -Body '{"packages":["git+https://github.com/x/y",""]}' -TimeoutSec 30
  Check '批量安装返回结果数组' ($res.results.Count -eq 2) ($res | ConvertTo-Json -Compress)
  $r0 = $res.results[0]; $r1 = $res.results[1]
  Check 'git 来源包被拒且带错误' (-not $r0.ok -and $r0.error) ($r0 | ConvertTo-Json -Compress)
  Check '空包名被拒' (-not $r1.ok) ($r1 | ConvertTo-Json -Compress)
  Check '批量统计失败数' ($res.failed -eq 2) ($res.failed)

  # 4) 可用插件列表（含依赖+bundle 来源）
  $av = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/available"
  $alphaList = @($av.available.alpha)
  # alpha 依赖 2 个 + bundle 1 个（dsh-base 重复 → 去重后 2 个）
  Check 'available alpha 含 2 个插件' ($alphaList.Count -eq 2) ($alphaList | ConvertTo-Json -Compress)
  $webApp = $alphaList | Where-Object { $_.pluginId -eq '@deepseek-ai/dsh-web-app' }
  Check 'available 依赖来源正确' ($null -ne $webApp -and $webApp.source -eq 'dependency' -and -not $webApp.allocated) ($webApp | ConvertTo-Json -Compress)

  # 5) 拖拽分配落地：把可用插件分配进 alpha（走 API），再验证可添加区变少
  $alloc = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"@deepseek-ai/dsh-web-app","pluginName":"@deepseek-ai/dsh-web-app"}' -TimeoutSec 10
  Check '新建分配成功' ($null -ne $alloc.allocation.id) ($alloc | ConvertTo-Json -Compress)
  $av2 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/available"
  $webApp2 = @($av2.available.alpha) | Where-Object { $_.pluginId -eq '@deepseek-ai/dsh-web-app' }
  Check '分配后 available 标记 allocated' ($webApp2.allocated -eq $true) ($webApp2 | ConvertTo-Json -Compress)

  # 6) 跨 Profile 移动分配
  $mv = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/$($alloc.allocation.id)/move" -Method Post -ContentType 'application/json' -Body '{"profile":"beta"}' -TimeoutSec 10
  Check '跨 Profile 移动成功' ($mv.allocation.profile -eq 'beta') ($mv | ConvertTo-Json -Compress)

  # 7) 删除分配（清理）
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/$($alloc.allocation.id)" -Method Delete -TimeoutSec 10 | Out-Null
  Check '删除分配成功' $true ''

  # 8) 删除环境 API（运行中禁止的逻辑用 status 验证即可，这里直接删 alpha）
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles/alpha" -Method Delete -TimeoutSec 10 | Out-Null
  $p2 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/profiles"
  Check '删除后列表仅剩 beta' (@($p2.profiles).Count -eq 1 -and $p2.profiles[0].name -eq 'beta') ($p2 | ConvertTo-Json -Compress)
}
catch {
  Write-Output "FAIL  异常: $_"
  $ok = $false
}
finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  try { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } catch {}
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_LAUNCHER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_LAUNCHER_SKIP_NPM_UNINSTALL -ErrorAction SilentlyContinue
}

if ($ok) { Write-Output '== 冒烟测试全部通过 ==' } else { Write-Output '== 冒烟测试存在失败 ==' }
exit ($(if ($ok) { 0 } else { 1 }))
