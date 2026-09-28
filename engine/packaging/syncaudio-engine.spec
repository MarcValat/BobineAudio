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
    # The engine only imports scipy.fft (see syncaudio/dsp.py), which pulls
    # in scipy.linalg and scipy.special and nothing else. PyInstaller follows
    # scipy's lazy imports statically and would bundle the rest of it
    # (~30MB) for nothing.
    excludes=[
        "scipy.cluster",
        "scipy.constants",
        "scipy.datasets",
        "scipy.differentiate",
        "scipy.integrate",
        "scipy.interpolate",
        "scipy.io",
        "scipy.misc",
        "scipy.ndimage",
        "scipy.odr",
        "scipy.optimize",
        "scipy.signal",
        "scipy.sparse",
        "scipy.spatial",
        "scipy.stats",
        "tkinter",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="syncaudio-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="syncaudio-engine",
)
