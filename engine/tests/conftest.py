from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest
from synthetic import make_bed, write_wav

from syncaudio.ffmpeg_backend import resolve_ffmpeg


@pytest.fixture(autouse=True)
def _no_persistent_analysis_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never read or write the user's real on-disk analysis cache from tests."""
    monkeypatch.setenv("SYNCAUDIO_CACHE_DIR", "")


# A synthetic file shared by the server's and the command line's tests.


@pytest.fixture()
def offset_mkv(tmp_path: Path) -> tuple[Path, float]:
    """A 2-track mkv (dummy video + reference + candidate lagging by 3s)."""
    sr = 44100
    duration_s = 30.0
    offset_s = 3.0

    bed = make_bed(duration_s, sr, seed=42)
    shifted = np.concatenate([np.zeros(int(offset_s * sr)), bed])[: len(bed)]

    ref_wav = tmp_path / "ref.wav"
    cand_wav = tmp_path / "cand.wav"
    write_wav(ref_wav, bed, sr)
    write_wav(cand_wav, shifted, sr)

    mkv = tmp_path / "multi.mkv"
    ffmpeg = resolve_ffmpeg()
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s=64x64:d={duration_s}",
            "-i",
            str(ref_wav),
            "-i",
            str(cand_wav),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-metadata:s:a:0",
            "language=jpn",
            "-metadata:s:a:1",
            "language=fre",
            "-shortest",
            str(mkv),
        ],
        check=True,
        capture_output=True,
    )
    return mkv, offset_s
