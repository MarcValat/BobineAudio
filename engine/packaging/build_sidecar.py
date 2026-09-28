"""Build the FastAPI sidecar as a standalone folder and drop it where the Tauri
app bundles it from.

Usage (from engine/):  uv run python packaging/build_sidecar.py

Runs PyInstaller against syncaudio-engine.spec, which produces a folder
(PyInstaller's "onedir": the exe plus its libraries next to it, nothing
unpacked at launch), then copies that folder to
app/src-tauri/binaries/syncaudio-engine/. tauri.conf.json's
`bundle.resources` ships it as `engine/` next to the app's exe, where
src-tauri/src/lib.rs launches it from.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
BINARIES_DIR = ENGINE_DIR.parent / "app" / "src-tauri" / "binaries"


def main() -> None:
    subprocess.run(
        ["uv", "run", "pyinstaller", "packaging/syncaudio-engine.spec", "--noconfirm"],
        cwd=ENGINE_DIR,
        check=True,
    )

    built = ENGINE_DIR / "dist" / "syncaudio-engine"
    if not built.is_dir():
        raise SystemExit(f"expected PyInstaller output at {built}, not found")

    # Replaced whole: a file dropped from the build must not linger in the bundle.
    if BINARIES_DIR.exists():
        shutil.rmtree(BINARIES_DIR)
    shutil.copytree(built, BINARIES_DIR / "syncaudio-engine")
    print(f"[build_sidecar] {built} -> {BINARIES_DIR / 'syncaudio-engine'}")


if __name__ == "__main__":
    main()
