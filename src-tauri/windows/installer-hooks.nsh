; Lamplit's additions to the NSIS installer that Tauri builds (bundle > windows > nsis > installerHooks in
; tauri.conf.json). $UpdateMode, $PassiveMode and $DeleteAppDataCheckboxState come from Tauri's installer template.
;
; `lamplit.exe --setup` registers the logon task lamplit-<the account's SID> and records that it did in setup.json in
; Lamplit's data folder, %LOCALAPPDATA%\lamplit. The default install folder, %LOCALAPPDATA%\Lamplit, is that same
; folder.

; After the files are gone, so an uninstall that stops early (the player keeps Lamplit running) changes nothing.
!macro NSIS_HOOK_POSTUNINSTALL
  ; An update (/UPDATE), or a newer installer that runs this uninstaller in place before it installs again, keeps the
  ; task: the new lamplit.exe lands where the old one was. Any other uninstall removes the task and the setup record,
  ; so a Lamplit installed again asks for setup again.
  ${If} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    ; Setup registers the task with admin rights, so this account can usually only read it, and deleting it takes
    ; Windows' admin prompt. A silent or passive uninstall doesn't stop for that prompt and leaves the task.
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      StrCpy $1 "$$false"
    ${Else}
      StrCpy $1 "$$true"
    ${EndIf}
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ask = $1; $$name = 'lamplit-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (-not (Get-ScheduledTask -TaskPath '\' -TaskName $$name -ErrorAction SilentlyContinue)) { exit }; try { Unregister-ScheduledTask -TaskPath '\' -TaskName $$name -Confirm:$$false -ErrorAction Stop; exit } catch {}; if ($$ask) { try { Start-Process schtasks.exe '/Delete', '/TN', $$name, '/F' -Verb RunAs -WindowStyle Hidden -Wait } catch {} }; if (Get-ScheduledTask -TaskPath '\' -TaskName $$name -ErrorAction SilentlyContinue) { 'The logon task ' + $$name + ' is still there: delete it in Task Scheduler.' }"`
    Pop $0
    Delete "$LOCALAPPDATA\lamplit\setup.json"
  ${EndIf}

  ; "Delete the application data" removes the WebView's folder, named after the identifier, and Lamplit's own.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\lamplit"
  ${EndIf}
!macroend
