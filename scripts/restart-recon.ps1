#!/usr/bin/env pwsh
# 重启重建版 Knowly（仅限 E:\data\Knowly 下的进程，绝不触碰原版 E:\soft\Knowly）
param(
  [switch]$NoDebug,
  [switch]$StopOnly,
  [switch]$NoStop
)

$root = 'E:\data\Knowly'
$exe = Join-Path $root 'Knowly.exe'

function Get-ReconProcs {
  Get-CimInstance Win32_Process -Filter "Name='Knowly.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }
}

if (-not $NoStop) {
  $procs = Get-ReconProcs
  if ($procs) {
    Write-Host "停止重建版进程 $($procs.Count) 个（PID: $($procs.ProcessId -join ', ')）"
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    # 等待句柄释放（app.asar 被占用时替换会 EBUSY）
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 400
      if (-not (Get-ReconProcs)) { break }
    }
    $left = Get-ReconProcs
    if ($left) { Write-Host "警告：仍有 $($left.Count) 个进程未退出" -ForegroundColor Yellow }
    else { Write-Host '进程已全部退出' }
  } else {
    Write-Host '没有正在运行的重建版进程'
  }
}

if ($StopOnly) { exit 0 }

$listener = Get-NetTCPConnection -LocalPort 28099 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host "等待 28099 释放（当前 PID $($listener.OwningProcess -join ',')）…"
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 400
    if (-not (Get-NetTCPConnection -LocalPort 28099 -State Listen -ErrorAction SilentlyContinue)) { break }
  }
}

$args = @()
if (-not $NoDebug) { $args += '--remote-debugging-port=9334' }
Write-Host "启动: $exe $($args -join ' ')"
Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $root | Out-Null

# 等待主窗口/后端就绪
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 1000
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:28099/health' -TimeoutSec 2
    if ($h.status -eq 'ok') { Write-Host '后端就绪 (health ok)'; break }
  } catch { }
}
if (-not $NoDebug) {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9334/json/version' -TimeoutSec 2
      if ($v.webSocketDebuggerUrl) { Write-Host '调试端口就绪 (9334)'; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
  }
}
Write-Host '完成'
