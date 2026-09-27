; NSIS hooks wired in via bundle.windows.nsis.installerHooks (tauri.conf.json).
;
; The installer's own "is the app running?" check only knows about the main
; exe, not the engine sidecar the app launches alongside it. An engine left
; running (by a version predating the app-side lifetime fixes, a crash, a
; forced kill...) keeps syncaudio-engine.exe locked, and overwriting or
; deleting it then fails with "Error opening file for writing". Killing it
; here makes install/update/uninstall independent of how the previous
; instance ended -- including updating *from* an old version whose own code
; can't be fixed after the fact.
;
; nsExec runs taskkill without flashing a console window. A non-zero exit
; code just means no engine was running; the result is discarded either way.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
!macroend
