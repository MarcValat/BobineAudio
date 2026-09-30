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
  ; Started by the in-app updater as the app exits: in front of the other
  ; windows, not behind them (the app allowed it, see prepare_update_install
  ; in src/lib.rs).
  BringToFront
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
  ; Versions up to 1.0.x shipped the engine as a single exe at the install
  ; root; it now lives in engine\. An update would otherwise leave the old
  ; ~90MB file behind for good.
  Delete "$INSTDIR\syncaudio-engine.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
!macroend

; The engine's analysis cache (engine/src/syncaudio/analysis_cache.py:
; %LOCALAPPDATA%\SyncAudio\cache, up to ~512MB) is written at run time, so
; the uninstaller doesn't know about it and would leave it behind -- along
; with the SyncAudio folder it sits in, which is also the default install
; folder. It's only a cache, rebuilt on demand: always removed. RMDir
; without /r only removes the folder if nothing else is left in it.
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$LOCALAPPDATA\SyncAudio\cache"
  RMDir "$LOCALAPPDATA\SyncAudio"
!macroend
