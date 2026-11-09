; Lamplit's additions to the NSIS installer that Tauri builds (bundle > windows > nsis > installerHooks in
; tauri.conf.json). $UpdateMode, $PassiveMode and $DeleteAppDataCheckboxState come from Tauri's installer template.
;
; The default install folder and the data folder, %LOCALAPPDATA%\lamplit, are the same folder.
Var LamplitRestoreResult

; Lamplit runs as two processes of the same lamplit.exe: a supervisor that restarts the app after a crash, and the app.
; Tauri's check that runs next closes them through Windows' Restart Manager, which failed on that pair ("Failed to kill
; Lamplit") and aborted uninstalls. So the copy in $INSTDIR is ended here first, the supervisor before the app so it
; can't start the app again. By force: asked to close (taskkill without /F), the app lost its window but kept
; running, and a forced end loses nothing, since Lamplit writes each file in one step and has nothing to undo when it
; ends. Only those two processes: a game started from Lamplit keeps running, and so does a lamplit.exe elsewhere. The
; path goes in through the environment because it may hold a quote.
!macro LAMPLIT_CLOSE
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAMPLIT_EXE", t "$INSTDIR\${MAINBINARYNAME}.exe")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$lamplit = @(Get-CimInstance Win32_Process -Filter 'Name=''${MAINBINARYNAME}.exe''' | Where-Object ExecutablePath -eq $$env:LAMPLIT_EXE | Sort-Object { $$_.CommandLine -like '*--app*' }); foreach ($$p in $$lamplit) { Stop-Process -Id $$p.ProcessId -Force -ErrorAction SilentlyContinue }; if ($$lamplit) { Wait-Process -Id $$lamplit.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LAMPLIT_CLOSE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LAMPLIT_CLOSE
  StrCpy $LamplitRestoreResult "skipped"
  ; Updates and reinstalls in place keep the account's settings and sign-in task.
  ${If} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    ; Only deletion of a legacy task that returns Access denied may show an admin prompt.
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      StrCpy $1 "--no-prompt"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore $1' $LamplitRestoreResult
    ${If} $LamplitRestoreResult != 0
      ; Both Tauri's template and the hook below see this, so pending originals survive Delete application data.
      StrCpy $DeleteAppDataCheckboxState 0
      DetailPrint "Some settings could not be restored. Saved originals and restore.log remain in $LOCALAPPDATA\lamplit."
      ${IfNot} ${Silent}
      ${AndIf} $PassiveMode <> 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "Some settings are still waiting. Your saved originals are kept in $LOCALAPPDATA\lamplit. Read restore.log, then run Lamplit again and choose Restore Lamplit's changes."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Delete the application data" removes the WebView's folder, named after the identifier, and Lamplit's own.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
  ${AndIf} $LamplitRestoreResult = 0
    RMDir /r "$LOCALAPPDATA\lamplit"
  ${EndIf}
!macroend
