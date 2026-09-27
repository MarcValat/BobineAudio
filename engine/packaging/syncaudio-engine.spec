# PyInstaller spec for the FastAPI sidecar (see server.py/cli.py's `serve`
# command), bundled as a standalone binary so the packaged Tauri app never
# needs Python or `uv` on the end user's machine. Run from `engine/`:
#
#   uv run pyinstaller packaging/syncaudio-engine.spec --noconfirm
#
# Output lands in engine/dist/syncaudio-engine.exe -- see
# packaging/build_sidecar.py for the step that renames/copies it into
# app/src-tauri/binaries/ with the target-triple suffix Tauri's sidecar
# mechanism expects.
#
# console=False (no --console): this is spawned silently by the Tauri shell
# as a background sidecar, not run interactively -- a visible console
# window popping up alongside the GUI would look broken. Its stdout/stderr
# aren't currently read by the Rust side either way (see lib.rs), so
# nothing is lost.
a = Analysis(
    ["../src/syncaudio/cli.py"],
    pathex=["../src"],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="syncaudio-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
