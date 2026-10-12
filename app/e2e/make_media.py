"""The end-to-end tests' media, synthetic: nothing copyrighted to provide.

Usage (from app/, the engine's environment has numpy and ffmpeg):
    uv run --project ../engine python e2e/make_media.py [out_dir]

Each audio track is built like a real dub: a shared bed (music notes and
sound effects) under a "voice" of its own language (formant-filtered noise in
syllables and phrases), the bed shifted in the tracks to correct by a known
offset -- what the tests expect the analysis to find (see MEDIA below and
e2e/media.ts). Deterministic (seeded): the same files every time.

Rewritten only when this script changed (its hash in out_dir/stamp.txt).
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

from syncaudio.ffmpeg_backend import resolve_ffmpeg

RATE = 48000
DURATION = 60.0

# Offsets in seconds: a track to correct plays the reference's moment t at
# t + offset (positive: it's late). A jump: (time, offset) breakpoints.
MEDIA = {
    "Show - E01.mkv": {
        "seed": 1,
        "tracks": [("jpn", "aac", "Japonais", 0.0), ("fre", "ac3", "Français", 1.2), ("eng", "libopus", "English", -0.8)],
        "subtitles": [("fre", "ass", "Français (forcés)", True), ("eng", "srt", "English", False)],
    },
    "Show - E02.mkv": {
        "seed": 2,
        "tracks": [("jpn", "aac", "Japonais", 0.0), ("fre", "ac3", "Français", [(0.0, 0.5), (30.0, 2.5)]), ("eng", "libopus", "English", -0.8)],
        "subtitles": [("fre", "ass", "Français (forcés)", True)],
    },
    "Show - E03.mkv": {
        "seed": 3,
        "tracks": [("jpn", "aac", "Japonais", 0.0), ("fre", "ac3", "Français", 0.4), ("eng", "libopus", "English", -0.3)],
        "subtitles": [],
    },
    # One track to correct, early (a negative offset).
    "Show - E04.mkv": {"seed": 4, "tracks": [("jpn", "aac", "Japonais", 0.0), ("fre", "ac3", "Français", -1.0)], "subtitles": []},
    # Pairs: the dub alone, against the same episode's video above.
    "Show - E01 (VF).mka": {"seed": 1, "pair_of": "Show - E01.mkv", "tracks": [("fre", "ac3", "VF", 0.7)], "subtitles": []},
    "Show - E02 (VF).mka": {"seed": 2, "pair_of": "Show - E02.mkv", "tracks": [("fre", "ac3", "VF", 1.5)], "subtitles": []},
}


def bandpass(signal: np.ndarray, low: float, high: float) -> np.ndarray:
    spectrum = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(len(signal), 1 / RATE)
    spectrum[(freqs < low) | (freqs > high)] = 0
    return np.fft.irfft(spectrum, len(signal))


def envelope(rng: np.random.Generator, n: int, on: tuple[float, float], off: tuple[float, float], fade: float) -> np.ndarray:
    """Random bursts: on for `on` seconds, off for `off` (uniform ranges), faded."""
    env = np.zeros(n)
    t = rng.uniform(*off)
    while t < n / RATE:
        length = rng.uniform(*on)
        a, b = int(t * RATE), min(n, int((t + length) * RATE))
        if b > a:
            ramp = min(int(fade * RATE), (b - a) // 2)
            burst = np.ones(b - a) * rng.uniform(0.4, 1.0)
            if ramp:
                burst[:ramp] *= np.linspace(0, 1, ramp)
                burst[-ramp:] *= np.linspace(1, 0, ramp)
            env[a:b] = burst
        t += length + rng.uniform(*off)
    return env


def bed(seed: int, seconds: float) -> np.ndarray:
    """Music notes (a few harmonics each) and noise-burst effects."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    out = np.zeros(n)
    t = 0.0
    while t < seconds:
        length = rng.uniform(0.15, 0.8)
        a, b = int(t * RATE), min(n, int((t + length) * RATE))
        f0 = rng.uniform(110, 880)
        x = np.arange(b - a) / RATE
        note = sum(np.sin(2 * np.pi * f0 * k * x) / k for k in (1, 2, 3))
        note *= np.exp(-x * rng.uniform(2, 8))
        out[a:b] += 0.3 * note
        t += length * rng.uniform(0.6, 1.0)
    effects = bandpass(rng.standard_normal(n), 2000, 9000) * envelope(rng, n, (0.05, 0.4), (0.3, 2.5), 0.01)
    return out + 0.5 * effects


def voice(seed: int, seconds: float) -> np.ndarray:
    """Syllables (~5 a second) in phrases, a language's own."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    syllables = envelope(rng, n, (0.08, 0.22), (0.03, 0.12), 0.02)
    phrases = envelope(rng, n, (1.0, 4.0), (0.5, 2.0), 0.05)
    formants = sum(bandpass(rng.standard_normal(n), f, f * 1.4) for f in (500, 1500, 2500))
    return formants * syllables * (phrases > 0)


def shifted(source: np.ndarray, offset, filler_seed: int) -> np.ndarray:
    """`source` as a track `offset` late (a number, or (time, offset) breakpoints
    -- a rise inserts new content there, a drop loses some)."""
    points = offset if isinstance(offset, list) else [(0.0, offset)]
    rng = np.random.default_rng(filler_seed)
    n = len(source)
    out = rng.standard_normal(n) * 0.02  # room tone where nothing maps
    for i, (start, off) in enumerate(points):
        end = points[i + 1][0] if i + 1 < len(points) else n / RATE
        # Reference [start, end) lands at [start + off, end + off).
        a, b = int((start + off) * RATE), int((end + off) * RATE)
        src_a, src_b = int(start * RATE), int(end * RATE)
        lo, hi = max(a, 0), min(b, n)
        if hi > lo:
            out[lo:hi] = source[src_a + (lo - a) : src_a + (hi - a)]
        if i > 0:
            gap_a = int((start + points[i - 1][1]) * RATE)
            if a > gap_a:  # extra content the reference doesn't have
                out[gap_a:a] = bed(filler_seed + 100, (a - gap_a) / RATE)[: a - gap_a] * 0.8
    return out


def write_wav(path: Path, mono: np.ndarray) -> None:
    peak = np.max(np.abs(mono)) or 1.0
    pcm = (mono / peak * 0.7 * 32767).astype(np.int16)
    stereo = np.repeat(pcm[:, None], 2, axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(stereo.tobytes())


SUBTITLE_LINES = [(2.0, 4.0, "Panneau : Gare"), (20.0, 22.5, "Une ligne en langue étrangère"), (45.0, 47.0, "Fin")]


def write_subtitle(path: Path, kind: str) -> None:
    def ts(seconds: float, sep: str, digits: int) -> str:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        frac = f"{s % 1:.{digits}f}"[2:]
        return f"{int(h):{'02' if sep == ',' else ''}d}:{int(m):02d}:{int(s):02d}{sep}{frac}"

    if kind == "srt":
        blocks = [f"{i + 1}\n{ts(a, ',', 3)} --> {ts(b, ',', 3)}\n{text}\n" for i, (a, b, text) in enumerate(SUBTITLE_LINES)]
        path.write_text("\n".join(blocks), encoding="utf-8")
    else:
        events = "\n".join(f"Dialogue: 0,{ts(a, '.', 2)},{ts(b, '.', 2)},Default,,0,0,0,,{text}" for a, b, text in SUBTITLE_LINES)
        path.write_text(
            "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV\n"
            "Style: Default,Arial,20,&H00FFFFFF,0,0,2,10,10,10\n\n[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events + "\n",
            encoding="utf-8",
        )


def make(out_dir: Path, name: str, spec: dict, tmp: Path) -> None:
    seed = spec["seed"]
    shared = bed(seed, DURATION)
    inputs: list[str] = []
    maps: list[str] = []
    meta: list[str] = []
    video = "pair_of" not in spec
    if video:
        inputs += ["-f", "lavfi", "-i", f"color=c=0x203048:s=320x180:r=10:d={DURATION}"]
        maps += ["-map", "0:v"]
    for i, (language, codec, title, offset) in enumerate(spec["tracks"]):
        # The voice: the reference's own, each dub's own (seeded by language).
        lang_seed = seed * 1000 + sum(map(ord, language)) + (7 if not video else 0)
        mixed = 0.7 * shifted(shared, offset, seed * 10 + i) + 0.5 * voice(lang_seed, DURATION)
        wav = tmp / f"{seed}-{i}-{video}.wav"
        write_wav(wav, mixed)
        inputs += ["-i", str(wav)]
        maps += ["-map", f"{len(maps) // 2}:a"]
        a = i
        meta += [f"-c:a:{a}", codec, f"-metadata:s:a:{a}", f"language={language}", f"-metadata:s:a:{a}", f"title={title}"]
        if codec == "libopus":
            meta += [f"-b:a:{a}", "96k"]
    for i, (language, kind, title, forced) in enumerate(spec["subtitles"]):
        sub = tmp / f"{seed}-{i}.{kind}"
        write_subtitle(sub, kind)
        inputs += ["-i", str(sub)]
        maps += ["-map", f"{len(maps) // 2}:s"]
        meta += [f"-c:s:{i}", kind, f"-metadata:s:s:{i}", f"language={language}", f"-metadata:s:s:{i}", f"title={title}"]
        meta += [f"-disposition:s:{i}", "forced" if forced else "0"]
    if video:
        meta += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "40", "-pix_fmt", "yuv420p"]
    cmd = [resolve_ffmpeg(), "-v", "error", "-y", *inputs, *maps, *meta, "-t", str(DURATION), str(out_dir / name)]
    subprocess.run(cmd, check=True)


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "media"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    stamp_file = out_dir / "stamp.txt"
    if stamp_file.exists() and stamp_file.read_text() == stamp and all((out_dir / n).exists() for n in MEDIA):
        print(f"media up to date in {out_dir}")
        return
    with tempfile.TemporaryDirectory() as tmp:
        for name, spec in MEDIA.items():
            make(out_dir, name, spec, Path(tmp))
            print(f"made {name}")
    stamp_file.write_text(stamp)


if __name__ == "__main__":
    main()
