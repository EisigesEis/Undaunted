!include LogicLib.nsh
!define LEGACY_MIGRATION_DIR "$TEMP\undauntedlauncher-migration"

!macro CleanupLegacySquirrel
  StrCpy $0 0
legacy_cleanup_retry:
  DetailPrint "Scanning legacy Squirrel installation..."
  FindFirst $3 $4 "$LOCALAPPDATA\undauntedlauncher\app-*"
legacy_cleanup_app_loop:
  StrCmp $4 "" legacy_cleanup_apps_done
  DetailPrint "Deleting legacy package: $LOCALAPPDATA\undauntedlauncher\$4"
  Delete "$LOCALAPPDATA\undauntedlauncher\$4\squirrel.exe"
  RMDir /r "$LOCALAPPDATA\undauntedlauncher\$4"
  FindNext $3 $4
  Goto legacy_cleanup_app_loop
legacy_cleanup_apps_done:
  FindClose $3
  DetailPrint "Deleting legacy Squirrel updater files..."
  Delete "$LOCALAPPDATA\undauntedlauncher\squirrel.exe"
  Delete "$LOCALAPPDATA\undauntedlauncher\.dead"
  Delete "$LOCALAPPDATA\undauntedlauncher\Update.exe"
  RMDir /r "$LOCALAPPDATA\undauntedlauncher\packages"
  Delete "$LOCALAPPDATA\undauntedlauncher\app.ico"
  Delete "$LOCALAPPDATA\undauntedlauncher\Squirrel-Shortcut.log"

  IfFileExists "$LOCALAPPDATA\undauntedlauncher\app-*" legacy_cleanup_still_present
  IfFileExists "$LOCALAPPDATA\undauntedlauncher\squirrel.exe" legacy_cleanup_still_present
  IfFileExists "$LOCALAPPDATA\undauntedlauncher\Update.exe" legacy_cleanup_still_present
  IfFileExists "$LOCALAPPDATA\undauntedlauncher\.dead" legacy_cleanup_still_present
  RMDir "$LOCALAPPDATA\undauntedlauncher"
  DetailPrint "Legacy Squirrel files deleted."
  Goto legacy_cleanup_done

legacy_cleanup_still_present:
  IntOp $0 $0 + 1
  ${If} $0 < 30
    DetailPrint "Legacy files are still in use; retrying cleanup ($0/30)..."
    Sleep 500
    Goto legacy_cleanup_retry
  ${EndIf}
  MessageBox MB_ICONSTOP "The previous Undaunted Launcher is still using files in $LOCALAPPDATA\undauntedlauncher. Close it and run this installer again."
  Abort
legacy_cleanup_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Preserving legacy launcher settings..."
  CreateDirectory "${LEGACY_MIGRATION_DIR}"
  IfFileExists "$APPDATA\Undaunted Launcher\config.json" 0 legacy_config_captured
    CopyFiles /SILENT "$APPDATA\Undaunted Launcher\config.json" "${LEGACY_MIGRATION_DIR}"
    IfFileExists "${LEGACY_MIGRATION_DIR}\config.json" 0 legacy_capture_failed
    Delete "${LEGACY_MIGRATION_DIR}\legacy-config.json"
    Rename "${LEGACY_MIGRATION_DIR}\config.json" "${LEGACY_MIGRATION_DIR}\legacy-config.json"
    IfFileExists "${LEGACY_MIGRATION_DIR}\legacy-config.json" 0 legacy_capture_failed
    DetailPrint "Legacy settings preserved."

legacy_config_captured:
  IfFileExists "$LOCALAPPDATA\undauntedlauncher\Update.exe" 0 legacy_cleanup_without_uninstall
    DetailPrint "Running the official legacy uninstaller..."
    nsExec::ExecToStack '"$LOCALAPPDATA\undauntedlauncher\Update.exe" --uninstall'
    Pop $2
    ${If} $2 != 0
      MessageBox MB_ICONSTOP "The official legacy uninstaller failed with exit code $2. The preserved settings remain in ${LEGACY_MIGRATION_DIR}."
      Abort
    ${EndIf}
    DetailPrint "Waiting for the legacy Squirrel cleanup process to finish..."
    Sleep 10000

legacy_cleanup_without_uninstall:
  !insertmacro CleanupLegacySquirrel
  Goto legacy_preinstall_done

legacy_capture_failed:
  MessageBox MB_ICONSTOP "The previous Undaunted Launcher settings could not be preserved. No legacy files were removed."
  Abort
legacy_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "${LEGACY_MIGRATION_DIR}\legacy-config.json" 0 legacy_postinstall_no_config
    DetailPrint "Copying preserved settings to the new launcher..."
    CreateDirectory "$LOCALAPPDATA\Undaunted Launcher"
    CopyFiles /SILENT "${LEGACY_MIGRATION_DIR}\legacy-config.json" "$LOCALAPPDATA\Undaunted Launcher"
    IfFileExists "$LOCALAPPDATA\Undaunted Launcher\legacy-config.json" 0 legacy_stage_failed
    DetailPrint "Preserved settings copied successfully."
    Delete "${LEGACY_MIGRATION_DIR}\legacy-config.json"
    RMDir "${LEGACY_MIGRATION_DIR}"
    Goto legacy_postinstall_remove_roaming

legacy_postinstall_no_config:
  DetailPrint "No legacy settings file was found."

legacy_postinstall_remove_roaming:
  DetailPrint "Deleting legacy roaming application data..."
  RMDir /r "$APPDATA\Undaunted Launcher"
  DetailPrint "Deleting obsolete launcher WebView data..."
  RMDir /r "$LOCALAPPDATA\com.stayundaunted.launcher"
  DetailPrint "Legacy launcher migration and cleanup complete."
  Goto legacy_postinstall_done

legacy_stage_failed:
  MessageBox MB_ICONSTOP "The preserved settings could not be copied to $LOCALAPPDATA\Undaunted Launcher. They remain in ${LEGACY_MIGRATION_DIR}."
  Abort
legacy_postinstall_done:
!macroend
