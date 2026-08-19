# run_scheduled.ps1 - Invoke pending-invoice-checker via codebuddy CLI (headless).
# Called by Windows Task Scheduler on logon + every 2 hours.

$ErrorActionPreference = 'Stop'

$skillDir = 'C:\Users\EDY\.codebuddy\skills\pending-invoice-checker'
$cli      = 'D:\soft\workSoft\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy'
$taskFile = Join-Path $skillDir 'SCHEDULED_TASK.md'

$prompt = 'Read the file "' + $taskFile + '" and execute it strictly as instructed, including the login-guidance blocking-popup loop, the four-stage workflow, and the result popups.'

Set-Location -LiteralPath $skillDir

& node $cli -p $prompt --permission-mode bypassPermissions -y --output-format text
