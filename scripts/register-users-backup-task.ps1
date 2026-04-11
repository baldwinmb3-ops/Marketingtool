param(
  [string]$TaskName = 'MarketingTool Daily User Backup',
  [string]$At = '2:30AM'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runnerPath = (Resolve-Path (Join-Path $PSScriptRoot 'run-users-backup-auto.ps1')).Path
$userId = if ($env:USERDOMAIN) { "$($env:USERDOMAIN)\$($env:USERNAME)" } else { $env:USERNAME }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`"" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Parse($At))
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description 'Daily durable user backup for MarketingTool.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Output (@{
  ok = $true
  taskName = $task.TaskName
  taskPath = $task.TaskPath
  scheduledAt = $At
  nextRunTime = if ($taskInfo.NextRunTime) { $taskInfo.NextRunTime.ToString('o') } else { '' }
  runner = $runnerPath
  workingDirectory = $repoRoot
} | ConvertTo-Json -Depth 4)
