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
  ; The in-app updater starts this installer and exits at once: Windows
  ; then gives the foreground back to whatever window was behind the app,
  ; and a window of this installer would open behind it. Made topmost for
  ; an instant, then not: it lands above every other window, and they can
  ; still come back in front of it once clicked (SWP_NOSIZE | SWP_NOMOVE |
  ; SWP_NOACTIVATE = 0x13; -1/-2 = HWND_TOPMOST/HWND_NOTOPMOST).
  BringToFront
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x13)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x13)'
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
  ; Versions up to 1.0.x shipped the engine as a single exe at the install
  ; root; it now lives in engine\. An update would otherwise leave the old
  ; ~90MB file behind for good.
  Delete "$INSTDIR\syncaudio-engine.exe"

  ; SyncAudio became Bobine Audio in 1.5.0. The install folder and the
  ; installed-apps entry are keyed on the product name, so this would
  ; install Bobine Audio next to SyncAudio rather than over it: the old
  ; install is removed by its own uninstaller. Silent, it never deletes the
  ; app data (settings live under the unchanged identifier); _?= runs it in
  ; place and waits, leaving uninstall.exe and its folder to delete here.
  ; An update (/UPDATE) creates no Start menu shortcut and the old one is
  ; gone with SyncAudio, so the new one is created here.
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SyncAudio" "InstallLocation"
  StrCpy $2 $1 1
  ${If} $2 == '"'
    StrCpy $1 $1 -1 1
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$1\uninstall.exe"
    ExecWait '"$1\uninstall.exe" /S _?=$1'
    Delete "$1\uninstall.exe"
    ${If} $1 != $INSTDIR
      RMDir "$1"
    ${EndIf}
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  Pop $2
  Pop $1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM syncaudio-engine.exe'
  Pop $0
!macroend

; The engine's analysis cache (engine/src/syncaudio/analysis_cache.py:
; %LOCALAPPDATA%\Bobine Audio\cache, up to ~512MB) is written at run time,
; so the uninstaller doesn't know about it and would leave it behind --
; along with the Bobine Audio folder it sits in, which is also the default
; install folder. It's only a cache, rebuilt on demand: always removed.
; RMDir without /r only removes the folder if nothing else is left in it.
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$LOCALAPPDATA\Bobine Audio\cache"
  RMDir "$LOCALAPPDATA\Bobine Audio"
!macroend
