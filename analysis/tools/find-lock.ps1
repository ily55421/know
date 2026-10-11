
$target = 'E:dataKnowlyeleasewin-unpackedesourcesapp.asar'
Write-Host '目标:' $target
$procs = Get-Process | Where-Object { $_.Path -and (try { $null -ne ($_.Modules | Where-Object { $_.FileName -ieq $target }) } catch { $false }) }
if ($procs) { $procs | Select-Object Id,ProcessName,Path | Format-List } else { Write-Host '无进程以模块方式加载该文件' }
