#!/usr/bin/env pwsh
# 设计令牌浏览器探针：用真实（无头）浏览器读取指定自定义属性的**计算值**，
# 而不是靠读 CSS 源码推断级联结果。
#
# 为什么需要它：`:root` 与 `[data-theme='light']` 特异性相同，谁在文件后面谁赢；
# 只读源码很容易看错（方案 §9.6 的 U1 就是被覆盖了却「看着像对的」）。
#
# 用法：
#   pwsh -File scripts/probe-design-tokens.ps1                       # 测工作树
#   pwsh -File scripts/probe-design-tokens.ps1 -Ref HEAD             # 同时测 git 某个版本的 CSS（A/B）
#   pwsh -File scripts/probe-design-tokens.ps1 -Tokens "--vault-1,--vault-2"
#
# 退出码：0 = 三个主题都测到值；1 = 取不到结果（浏览器不可用等）。
param(
  [string]$Ref = '',
  [string[]]$Tokens = @('--vault-1', '--vault-2', '--vault-bg', '--vault-border'),
  [string]$CssPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CssPath) { $CssPath = Join-Path $repoRoot 'apps\shell-web\src\styles.css' }

# 找一个可用的 Chromium 内核浏览器
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) {
  Write-Host '未找到 Chrome/Edge，无法做浏览器实测' -ForegroundColor Red
  exit 1
}

$work = Join-Path $env:TEMP "godsh-token-probe-$(Get-Date -Format 'HHmmss')"
New-Item -ItemType Directory -Force $work | Out-Null

Copy-Item $CssPath (Join-Path $work 'current.css') -Force
$variants = @{ current = '工作树' }
if ($Ref) {
  # 取 git 中的相对路径（不用 Resolve-Path -Relative，它会给出 ".\x" 这类前缀）
  $rel = ($CssPath.Substring($repoRoot.Length) -replace '^[\\/]+', '') -replace '\\', '/'
  git -C $repoRoot show "${Ref}:$rel" | Set-Content -Path (Join-Path $work 'ref.css') -Encoding UTF8
  $variants['ref'] = "git $Ref"
}

$tokenList = ($Tokens | ForEach-Object { "'$_'" }) -join ', '
$html = @"
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="__CSS__" />
    <!-- 关掉过渡/动画：切换 data-theme 后立刻读 getComputedStyle 时，
         带 transition 的属性会返回动画起始值（上一个主题的值），会把正确的级联读成错的。 -->
    <style>
      *, *::before, *::after { transition: none !important; animation: none !important; }
    </style>
  </head>
  <body>
    <span class="badge vault" id="badge">vault</span>
    <button class="btn vault" id="btn">vault</button>
    <pre id="out">pending</pre>
    <script>
      const tokens = [$tokenList]
      const themes = [null, 'dark', 'light']
      const lines = []
      for (const t of themes) {
        if (t) document.documentElement.setAttribute('data-theme', t)
        else document.documentElement.removeAttribute('data-theme')
        const root = getComputedStyle(document.documentElement)
        lines.push('theme=' + (t ?? '(none)'))
        for (const tok of tokens) {
          lines.push('  ' + tok.padEnd(16) + ' = ' + root.getPropertyValue(tok).trim())
        }
        const badge = getComputedStyle(document.getElementById('badge'))
        const btn = getComputedStyle(document.getElementById('btn'))
        lines.push('  .badge.vault     bg=' + badge.backgroundColor + '  color=' + badge.color)
        lines.push('  .btn.vault       bg=' + btn.backgroundColor + '  color=' + btn.color)
      }
      document.getElementById('out').textContent = lines.join('\n')
    </script>
  </body>
</html>
"@

$ok = $true
foreach ($key in $variants.Keys) {
  $page = Join-Path $work "$key.html"
  Set-Content -Path $page -Value ($html.Replace('__CSS__', "$key.css")) -Encoding UTF8
  $dump = Join-Path $work "$key.dump.html"
  $url = "file:///$($page -replace '\\', '/')"
  # Chrome/Edge 是 GUI 子系统程序，从 PowerShell 直接调用时 stdout 不接管道，
  # 必须经 cmd 重定向到文件才能拿到 --dump-dom 的内容（实测如此）。
  cmd /c "`"$browser`" --headless=new --disable-gpu --no-first-run --user-data-dir=`"$work\profile-$key`" --virtual-time-budget=3000 --dump-dom `"$url`" > `"$dump`" 2> nul"
  $text = if (Test-Path $dump) { Get-Content $dump -Raw } else { '' }
  $m = [regex]::Match($text, '(?s)<pre id="out">(.*?)</pre>')
  Write-Host ''
  Write-Host "===== $($variants[$key])（$key）=====" -ForegroundColor Cyan
  if ($m.Success) {
    $m.Groups[1].Value.Trim() -split "`n" | ForEach-Object { Write-Host "  $($_.TrimEnd())" }
  } else {
    Write-Host '  取不到结果' -ForegroundColor Red
    $ok = $false
  }
}
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
if (-not $ok) { exit 1 }
exit 0
