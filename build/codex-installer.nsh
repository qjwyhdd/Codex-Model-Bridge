; Autostart is an explicit choice in the application. Remove only this app's
; login entry during uninstall; preserve configuration backups and user data.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Model Bridge"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OC Ferry Codex"
!macroend
