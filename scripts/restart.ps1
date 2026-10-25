# restart.ps1: put a new build in place and restart Lamplit through its logon task, during development. Run it from
# an elevated PowerShell on the PC that runs Lamplit.
# Copy the new build next to the installed lamplit.exe as lamplit.next.exe first: the running lamplit.exe is locked.
# The install folder is the one this account's logon task (registered by `lamplit.exe --setup`) starts Lamplit from.
# Each account has its own task, named after the account's SID, so run this as the account Lamplit runs for.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task = Get-ScheduledTask -TaskName "lamplit-$sid" -ErrorAction Stop
$dir = Split-Path $task.Actions[0].Execute
# lamplit.exe runs twice: a small supervisor and the app it restarts after a crash. Stop the supervisor first,
# or it starts a new app while the old one is being stopped.
function LamplitProcesses { Get-CimInstance Win32_Process -Filter "Name='lamplit.exe'" }
LamplitProcesses | Where-Object { $_.CommandLine -notmatch '--app' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
for ($i = 0; $i -lt 10 -and (LamplitProcesses); $i++) { LamplitProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }
if (Test-Path "$dir\lamplit.next.exe") { Move-Item "$dir\lamplit.next.exe" "$dir\lamplit.exe" -Force }
Start-ScheduledTask -TaskName $task.TaskName
Start-Sleep 2
LamplitProcesses | ForEach-Object { "lamplit running, pid $($_.ProcessId), $(if ($_.CommandLine -match '--app') { 'app' } else { 'supervisor' })" }
