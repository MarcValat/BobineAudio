"""Build the FastAPI sidecar as a standalone binary and drop it where Tauri
expects an "external binary" (sidecar) to live.

Usage (from engine/):  uv run python packaging/build_sidecar.py

Tauri's sidecar mechanism (see app/src-tauri/tauri.conf.json's
`bundle.externalBin`) requires the binary to be named
`<name>-<rust-target-triple>[.exe]` -- this runs PyInstaller against
syncaudio-engine.spec, then copies+renames the result into
app/src-tauri/binaries/ with the current machine's triple (from `rustc
-vV`), which is also what `npm run tauri dev`/`tauri build` resolve against
on that same machine. Cross-compiling for another triple isn't handled here
since this project only targets Windows so far.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
SIDECAR_DIR = ENGINE_DIR.parent / "app" / "src-tauri" / "binaries"


def rust_target_triple() -> str:
    proc = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True)
    for line in proc.stdout.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("could not determine the Rust target triple from `rustc -vV`")


def main() -> None:
    subprocess.run(
        ["uv", "run", "pyinstaller", "packaging/syncaudio-engine.spec", "--noconfirm"],
        cwd=ENGINE_DIR,
        check=True,
    )

    triple = rust_target_triple()
    suffix = ".exe" if sys.platform == "win32" else ""
    built = ENGINE_DIR / "dist" / f"syncaudio-engine{suffix}"
    if not built.exists():
        raise SystemExit(f"expected PyInstaller output at {built}, not found")

    SIDECAR_DIR.mkdir(parents=True, exist_ok=True)
    target = SIDECAR_DIR / f"syncaudio-engine-{triple}{suffix}"
    shutil.copy2(built, target)
    print(f"[build_sidecar] {built} -> {target}")


if __name__ == "__main__":
    main()
