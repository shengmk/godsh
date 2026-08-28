# A 组冒烟：patch 写回守护（可解析性检查 + 备份） + CORS 收紧 + 安全头
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$work = Join-Path $env:TEMP ("dshl-a-smoke-" + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $work 'home'
$dataDir = Join-Path $work 'data'
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'profiles\alpha') | Out-Null

function Write-JsonNoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# 假 Profile：简单 patch
Write-JsonNoBom (Join-Path $homeDir 'profiles\alpha\package.json') '{ "name": "alpha", "dependencies": { "dep-a": "^1.0.0" }, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }'
Write-JsonNoBom (Join-Path $homeDir 'profiles\alpha\cordis.patch.yml') "- insert:
    - id: dep-a
"

$env:DSH_HOME = $homeDir
$env:DSH_LAUNCHER_DATA_DIR = $dataDir
$port = 48329
$server = Start-Process -FilePath 'node' -ArgumentList @("$root\apps\launcher\dist\server.mjs", 'serve', '--port', "$port") -PassThru -WindowStyle Hidden
$ok = $true
function Check($name, $cond, $extra) {
  if ($cond) { Write-Output "PASS  $name" }
  else { Write-Output "FAIL  $name  $extra"; $script:ok = $false }
}

try {
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  Check '服务启动' $ready 'health 未就绪'
  if (-not $ready) { throw 'server not ready' }

  # A3-1: 响应不含 Access-Control-Allow-Origin（同源收紧）
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing
  $acao = $resp.Headers['Access-Control-Allow-Origin']
  Check 'CORS: 同源无 ACAO 头' ($null -eq $acao -or $acao -eq '') ("ACAO=$acao")

  # A3-2: 安全响应头存在
  $nosniff = $resp.Headers['X-Content-Type-Options']
  $referrer = $resp.Headers['Referrer-Policy']
  Check '安全头: nosniff' ($nosniff -eq 'nosniff') ($nosniff)
  Check '安全头: no-referrer' ($referrer -eq 'no-referrer') ($referrer)

  # A3-3: 配置 allowedOrigins 后 CORS 放行（需带 Origin 请求，CORS 按请求 Origin 精确匹配）
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/settings" -Method Put -ContentType 'application/json' -Body '{"allowedOrigins":["http://localhost:5173"]}' -TimeoutSec 5 | Out-Null
  $resp2 = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -Headers @{Origin='http://localhost:5173'} -UseBasicParsing
  Check 'CORS: 配置后放行来源' ($resp2.Headers['Access-Control-Allow-Origin'] -eq 'http://localhost:5173') ($resp2.Headers['Access-Control-Allow-Origin'])
  # 白名单外 Origin 仍拒绝
  $resp3 = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -Headers @{Origin='http://evil.com'} -UseBasicParsing
  Check 'CORS: 白名单外拒绝' ($null -eq $resp3.Headers['Access-Control-Allow-Origin']) ($resp3.Headers['Access-Control-Allow-Origin'])
  # 还原为默认白名单（含 Tauri 来源）
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/settings" -Method Put -ContentType 'application/json' -Body '{"allowedOrigins":["http://tauri.localhost","https://tauri.localhost","tauri://localhost","http://localhost"]}' -TimeoutSec 5 | Out-Null

  # A2-1: 正常 patch 可分配写回（简单结构）
  $alloc = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"dep-a","pluginName":"dep-a"}' -TimeoutSec 5
  Check '分配写回成功' ($null -ne $alloc.allocation.id) ($alloc | ConvertTo-Json -Compress)
  $patchNow = Get-Content (Join-Path $homeDir 'profiles\alpha\cordis.patch.yml') -Raw
  Check 'patch 已写入分配' ($patchNow -match 'dep-a') ($patchNow)

  # A2-2: 备份文件生成（data/patches-backup/）
  Start-Sleep -Milliseconds 300
  $backups = Get-ChildItem (Join-Path $dataDir 'patches-backup') -ErrorAction SilentlyContinue
  Check 'patch 备份已生成' ($null -ne $backups -and $backups.Count -ge 1) ($backups.Count)

  # A2-3: 含无法解析结构的 patch → 拒绝写回（返回 409，分配被回滚）
  Write-JsonNoBom (Join-Path $homeDir 'profiles\alpha\cordis.patch.yml') @"
- insert:
    - id: dep-a
    - id: plugin-with-config
      config:
        nested: true
"@
  $rejected = $false
  $rollbackOk = $false
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -Method Post -ContentType 'application/json' -Body '{"profile":"alpha","pluginId":"dep-b","pluginName":"dep-b"}' -TimeoutSec 5
  } catch {
    $rejected = $true
    $errMsg = $_.ErrorDetails.Message
    Write-Output "    拒绝信息: $errMsg"
    # 验证回滚：dep-b 不应出现在分配列表
    $al = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/allocations" -TimeoutSec 5
    $rollbackOk = -not ($al.allocations | Where-Object { $_.pluginId -eq 'dep-b' })
  }
  Check '复杂 patch 拒绝写回(409)' $rejected '未被拒绝'
  Check '拒绝后分配已回滚' $rollbackOk 'dep-b 仍存在'

  # A2-4: 拒绝后原文件未被破坏（仍含 config 结构）
  $patchAfter = Get-Content (Join-Path $homeDir 'profiles\alpha\cordis.patch.yml') -Raw
  Check '拒绝后 patch 原样保留' ($patchAfter -match 'config:' -and $patchAfter -match 'nested') ($patchAfter)
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

if ($ok) { Write-Output '== A 组冒烟全部通过 ==' } else { Write-Output '== A 组冒烟存在失败 ==' }
exit ($(if ($ok) { 0 } else { 1 }))
