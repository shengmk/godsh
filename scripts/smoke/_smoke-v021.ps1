# godsh v0.2.2 新增功能冒烟测试（隔离环境，不碰真实 .dsh）
# 覆盖：合并轮询 /profiles/status、批量安装 /plugins/batch、可用插件 /allocations/available
#      + 官方资产退出「可分配」面（读法 α）：available 不含官方、分配官方被服务端拒绝、
#        历史遗留的官方分配记录仍可见（数据兼容）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$work = Join-Path $env:TEMP ("dshl-smoke-" + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $work 'home'
$dataDir = Join-Path $work 'data'
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'profiles\alpha') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'profiles\beta') | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# 无 BOM 写 JSON（scanner 用 JSON.parse，BOM 会导致解析失败）
function Write-JsonNoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# 两个假 Profile（alpha：2 个官方依赖 + 1 个官方 bundle + 1 个非官方依赖；beta 为空）
Write-JsonNoBom (Join-Path $homeDir 'profiles\alpha\package.json') '{ "name": "alpha", "dependencies": { "@deepseek-ai/dsh-base": "^0.1.0", "@deepseek-ai/dsh-web-app": "^0.1.0", "dsh-memory": "^1.0.0" }, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }'
Write-JsonNoBom (Join-Path $homeDir 'profiles\beta\package.json') '{ "name": "beta", "dependencies": {}, "dsh": { "profile": { "bundles": [] } } }'

# 历史数据兼容：预置一条「官方 bundle 的分配记录」，验证官方资产退出可分配面后它仍然可见、
# 不被隐藏（否则会出现「记录存在但界面不显示」的孤儿）
Write-JsonNoBom (Join-Path $dataDir 'allocations.json') '{ "allocations": [ { "id": "seed-official-headless", "profile": "alpha", "pluginId": "@deepseek-ai/dsh-headless", "pluginName": "@deepseek-ai/dsh-headless", "enabled": true, "order": 0 } ] }'

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

  # 4) 可用插件列表：官方资产必须**不在**其中（退出「可分配」面），只留有非官方依赖
  $av = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/available"
  $alphaList = @($av.available.alpha)
  # alpha 装了 2 个官方依赖 + 1 个官方 bundle（dsh-base 重复）+ 1 个非官方依赖 dsh-memory
  # → 过滤官方后只剩 1 条
  Check 'available alpha 仅剩 1 个非官方插件' ($alphaList.Count -eq 1) ($alphaList | ConvertTo-Json -Compress)
  $officialInAvail = @($alphaList | Where-Object { $_.pluginId -like '@deepseek-ai/*' })
  Check 'available 不含任何官方资产' ($officialInAvail.Count -eq 0) ($officialInAvail | ConvertTo-Json -Compress)
  $dep = $alphaList | Where-Object { $_.pluginId -eq 'dsh-memory' }
  Check 'available 依赖来源正确' ($null -ne $dep -and $dep.source -eq 'dependency' -and -not $dep.allocated) ($dep | ConvertTo-Json -Compress)

  # 4b) 官方资产只读视图：三项齐全，且 version 必须**如实地**等于该 Profile 的
  #     node_modules/<pkg>/package.json 里实际装到的版本；读不到那个文件才允许为 null。
  #     为什么不能断言「假 profile 就没有版本」：服务启动时的官方依赖同步会把各 Profile 的
  #     node_modules 链接补齐（实测日志「已同步 643 个官方依赖 … 来源: 驱动 CLI」），
  #     所以这里**确实**读得到版本。断言"应为 null"等于断言一件假事实，是把测试写歪，
  #     不是产品的缺陷。本断言校验的是**来源**（磁盘上的实装版本），而不是某个期望值。
  $assets = @($av.officialAssets.alpha)
  Check 'officialAssets alpha 含三个官方内核' ($assets.Count -eq 3) ($assets | ConvertTo-Json -Compress)
  $alphaDir = Join-Path $homeDir 'profiles\alpha'
  $provenanceOk = $true
  $provenanceDetail = @()
  foreach ($a in $assets) {
    $pkgJson = Join-Path $alphaDir ('node_modules\' + ($a.name -replace '/', '\') + '\package.json')
    $expected = $null
    if (Test-Path $pkgJson) { $expected = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version }
    if ($expected -ne $a.version) { $provenanceOk = $false }
    $provenanceDetail += "$($a.name): 报告=$($a.version) 磁盘=$expected"
  }
  Check 'officialAssets 版本来自磁盘实装（非编造/非市场最新号）' $provenanceOk ($provenanceDetail -join ' | ')
  Check 'officialAssets 每项都带 role 且非空' (@($assets | Where-Object { [string]::IsNullOrEmpty($_.role) }).Count -eq 0) ($assets | ConvertTo-Json -Compress)

  # 5a) 尝试分配官方 bundle → 服务端必须拒绝（400）
  $rejected = $false
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"@deepseek-ai/dsh-web-app","pluginName":"@deepseek-ai/dsh-web-app"}' -TimeoutSec 10 | Out-Null
  } catch { $rejected = $true }
  Check '分配官方 bundle 被服务端拒绝' $rejected '未被拒绝'

  # 5b) 历史遗留的官方分配记录仍然可见，且被标记 isOfficial（数据兼容，不产生孤儿）
  $all1 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations"
  $seed = @($all1.allocations) | Where-Object { $_.id -eq 'seed-official-headless' }
  Check '历史官方分配记录仍可见' ($null -ne $seed) ($all1 | ConvertTo-Json -Compress)
  Check '历史官方记录被标记 isOfficial' ($seed.isOfficial -eq $true) ($seed | ConvertTo-Json -Compress)

  # 5c) 非官方插件仍可正常分配（回归），且分配后 available 标记 allocated
  $alloc = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"dsh-memory","pluginName":"dsh-memory"}' -TimeoutSec 10
  Check '新建分配成功（非官方）' ($null -ne $alloc.allocation.id -and $alloc.allocation.isOfficial -eq $false) ($alloc | ConvertTo-Json -Compress)
  $av2 = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations/available"
  $dep2 = @($av2.available.alpha) | Where-Object { $_.pluginId -eq 'dsh-memory' }
  Check '分配后 available 标记 allocated' ($dep2.allocated -eq $true) ($dep2 | ConvertTo-Json -Compress)
  Check '分配操作后 available 仍无官方资产' (@($av2.available.alpha | Where-Object { $_.pluginId -like '@deepseek-ai/*' }).Count -eq 0) ($av2.available.alpha | ConvertTo-Json -Compress)

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
