<#
  setup-scheduled-tasks.ps1
  ------------------------------------------------------------------------------
  Register (or re-register) the weekly SEO run and its monitor as Windows
  Scheduled Tasks with REBOOT-PROOF settings.

  WHY THIS EXISTS: the usual reason "Friday morning, nothing happened" is that the
  task was set to "Run only when user is logged on", or "run a missed task" /
  "wake to run" were unchecked — so after a reboot to the login screen the task
  simply never fired and nothing alerted. This script sets all of those correctly:
    - Run whether the user is logged on or not (S4U, no stored password)
    - Start the task as soon as possible after a missed scheduled start
    - Wake the computer to run it
    - Allow start on battery / don't stop on battery

  RUN ONCE, from an *elevated* PowerShell (Run as Administrator):
      powershell -ExecutionPolicy Bypass -File C:\Workspace\Active\SEO-Agents-App\scripts\setup-scheduled-tasks.ps1

  Review the variables below before running.
#>

$ErrorActionPreference = 'Stop'

# --- Review these -------------------------------------------------------------
$ProjectRoot = 'C:\Workspace\Active\SEO-Agents-App'
$RunAsUser   = "$env:USERDOMAIN\$env:USERNAME"
$RunDay      = 'Friday'
$RunTime     = '08:30'          # weekly research kickoff (local time)
$MonitorHours = 14              # how long the monitor watches before exiting

# Python that has the crew installed (venv preferred). The wrapper itself now
# resolves seo-agents robustly, but the task must launch a Python that can import it.
$PythonExe = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $PythonExe)) { $PythonExe = (Get-Command python -ErrorAction SilentlyContinue)?.Source }
if (-not $PythonExe) { throw "No Python found. Expected $ProjectRoot\.venv\Scripts\python.exe or python on PATH." }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $NodeExe) { throw "node not found on PATH — required for the SEO monitor." }
# ------------------------------------------------------------------------------

function Register-RebootProofTask {
    param([string]$Name, [string]$Exe, [string]$Args, [datetime]$At)

    $action  = New-ScheduledTaskAction -Execute $Exe -Argument $Args -WorkingDirectory $ProjectRoot
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $RunDay -At $At
    $principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -WakeToRun `
        -ExecutionTimeLimit (New-TimeSpan -Hours ($MonitorHours + 2)) `
        -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Registered '$Name' -> $Exe $Args  ($RunDay $($At.ToString('HH:mm')))"
}

$at = [datetime]::ParseExact($RunTime, 'HH:mm', $null)

# 1) Weekly research kickoff
Register-RebootProofTask -Name 'Grizzly SEO Weekly Run' `
    -Exe $PythonExe `
    -Args ("`"{0}\scripts\run-weekly-seo.py`"" -f $ProjectRoot) `
    -At $at

# 2) Monitor (starts alongside; watches for MonitorHours, then exits)
Register-RebootProofTask -Name 'Grizzly SEO Monitor' `
    -Exe $NodeExe `
    -Args ("`"{0}\scripts\seo-monitor.mjs`" --run-hours {1}" -f $ProjectRoot, $MonitorHours) `
    -At $at

Write-Host ""
Write-Host "Done. Verify:"
Write-Host "  Get-ScheduledTaskInfo -TaskName 'Grizzly SEO Weekly Run'"
Write-Host "  Get-ScheduledTaskInfo -TaskName 'Grizzly SEO Monitor'"
Write-Host "Dry-test the wrapper now (writes outputs\weekly-runner-health.json):"
Write-Host "  Start-ScheduledTask -TaskName 'Grizzly SEO Weekly Run'"
