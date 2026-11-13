# 一键安装到当前 DSH profile
#   powershell -ExecutionPolicy Bypass -File .\install.ps1              # 装到 web profile
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 desktop      # 装到 desktop profile
param([string]$Profile = "web")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) 找 dsh 命令
$dsh = (Get-Command dsh -ErrorAction SilentlyContinue)?.Source
if (-not $dsh) {
  $candidates = @(
    "$env:ProgramFiles\deepseek harness\resources\runtime\cli\bin\dsh.cmd",
    "$env:LOCALAPPDATA\Programs\deepseek harness\resources\runtime\cli\bin\dsh.cmd"
  )
  $dsh = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $dsh) {
  Write-Host "没找到 dsh 命令。请手动执行：" -ForegroundColor Yellow
  Write-Host "  dsh plugin --profile $Profile add link:`"$here`""
  exit 1
}
Write-Host "使用 dsh: $dsh"

# 2) 装成本地链接（改代码即生效，不用反复打包）
& $dsh plugin --profile $Profile add "link:$here"

Write-Host ""
Write-Host "装好了。验证：" -ForegroundColor Green
Write-Host "  & '$dsh' --profile $Profile --dump-config | Select-String 'web-reader'"
Write-Host ""
Write-Host "然后重启 DSH（或让它 HMR 热加载），在新会话里就能看到 web_read 工具。"
Write-Host "命令行版随时可用：node `"$here\bin\webread.mjs`" <url>"
