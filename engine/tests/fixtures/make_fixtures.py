"""Genere des variantes volontairement desynchronisees de testfile.mkv.

Usage (depuis engine/) :
    uv run python tests/fixtures/make_fixtures.py

Prend un extrait de testfile.mkv (piste 0 = reference, jamais modifiee ;
piste 1 = candidate) et produit plusieurs MKV sous generated/, chacun avec
la candidate desynchronisee d'une facon differente et documentee au sample
pres dans MANIFEST.json.

Deux familles :
- candidate "dub" : la vraie piste doublee (fre). Realiste, mais sa relation
  a la reference n'est pas exactement nulle au depart (le doublage a ses
  propres micro-sauts de quelques dizaines de ms) : la verite n'est exacte
  qu'en relatif.
- candidate "reference" (fixtures exact_*) : la piste de reference elle-meme,
  degradee (egalisation + bruit, filtres sans latence notable, pas de codec
  avec perte qui decalerait le signal). Verite exacte au ms pres. Audio seul.

`--only nom1,nom2` ne regenere que ces fixtures (le manifeste est toujours
reecrit en entier : il est deterministe). Rien de ce que ce script lit ou ecrit n'est commite
(voir .gitignore) a part ce fichier et le manifeste.
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from syncaudio.ffmpeg_backend import resolve_ffmpeg

FIXTURES_DIR = Path(__file__).parent
GENERATED_DIR = FIXTURES_DIR / "generated"
PROJECT_ROOT = FIXTURES_DIR.parents[2]
DEFAULT_SOURCE = PROJECT_ROOT / "testfile.mkv"

REFERENCE_TRACK = 0  # jpn, ne doit jamais etre modifiee
CANDIDATE_TRACK = 1  # fre, c'est elle qu'on desynchronise


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Echec: {' '.join(cmd)}\n{proc.stderr.decode(errors='replace')}")


def extract_audio_wav(ffmpeg: str, source: Path, track: int, start: float, duration: float | None, out: Path) -> None:
    run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(start), "-i", str(source), *(["-t", str(duration)] if duration else []),
            "-map", f"0:a:{track}", "-c:a", "pcm_s16le", str(out),
        ]
    )


def degrade(data: np.ndarray, sr: int, seed: int = 99) -> np.ndarray:
    """The reference, made less trivially identical: band-limited, attenuated, noisy.

    First-order filters only: their group delay stays in the tens of
    microseconds over the audible band, far below what's being measured.
    """
    from scipy.signal import butter, lfilter

    x = data.astype(np.float64) / 32768.0
    b, a = butter(1, 150.0, btype="highpass", fs=sr)
    x = lfilter(b, a, x, axis=0)
    b, a = butter(1, 6000.0, btype="lowpass", fs=sr)
    x = 0.8 * lfilter(b, a, x, axis=0)
    x += np.random.default_rng(seed).normal(0.0, 0.003, x.shape)
    return np.clip(np.round(x * 32768.0), -32768, 32767).astype("<i2")


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        n_channels = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    data = np.frombuffer(raw, dtype="<i2").reshape(-1, n_channels)
    return data, sr


def write_wav(path: Path, data: np.ndarray, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(data.shape[1])
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(np.ascontiguousarray(data, dtype="<i2").tobytes())


@dataclass
class Breakpoint:
    time_s: float
    delta_s: float
    # What a positive delta inserts: "silence", or "noise" (extra content
    # that isn't a blank, e.g. a scene the reference doesn't have).
    fill: str = "silence"


def apply_piecewise_offset(cand: np.ndarray, sr: int, breakpoints: list[Breakpoint]) -> np.ndarray:
    """Apply a schedule of offset changes to a candidate track.

    At each breakpoint's ``time_s``, the candidate's lag behind the reference
    changes by ``delta_s`` from that point onward: a positive delta inserts
    that many seconds of silence (candidate now lags more), a negative delta
    removes that many seconds of candidate content (candidate now lags less
    / leads more).
    """
    chunks = []
    prev_sample = 0
    for bp in sorted(breakpoints, key=lambda b: b.time_s):
        idx = int(round(bp.time_s * sr))
        idx = max(idx, prev_sample)
        chunks.append(cand[prev_sample:idx])
        if bp.delta_s > 0:
            shape = (int(round(bp.delta_s * sr)), cand.shape[1])
            if bp.fill == "noise":
                noise = np.random.default_rng(int(bp.time_s * 1000)).normal(0.0, 0.1 * 32768, shape)
                chunks.append(np.clip(noise, -32768, 32767).astype(cand.dtype))
            else:
                chunks.append(np.zeros(shape, dtype=cand.dtype))
            prev_sample = idx
        else:
            cut = int(round(-bp.delta_s * sr))
            prev_sample = idx + cut
    chunks.append(cand[prev_sample:])
    return np.concatenate(chunks, axis=0)


def time_stretch(cand: np.ndarray, factor: float) -> np.ndarray:
    """Uniformly stretch (factor > 1) or compress (factor < 1) the whole track.

    Simulates a candidate running at a slightly different speed than the
    reference from the very first sample (progressive drift). Pitch is not
    preserved -- irrelevant here since detection works on the onset envelope,
    not pitch, and these are synthetic ground-truth fixtures, not deliverables.
    """
    n = len(cand)
    new_n = int(round(n * factor))
    old_idx = np.linspace(0, n - 1, new_n)
    base_idx = np.arange(n)
    out = np.stack(
        [np.interp(old_idx, base_idx, cand[:, ch]) for ch in range(cand.shape[1])],
        axis=1,
    )
    return out.astype(cand.dtype)


def mux(
    ffmpeg: str, source: Path, start: float, duration: float | None, ref_wav: Path, cand_wav: Path, out: Path,
    with_video: bool = True,
) -> None:
    ref_flac = ref_wav.with_suffix(".flac")
    cand_flac = cand_wav.with_suffix(".flac")
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(ref_wav), str(ref_flac)])
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(cand_wav), str(cand_flac)])
    video_in = ["-ss", str(start), *(["-t", str(duration)] if duration else []), "-i", str(source)] if with_video else []
    audio_input = 1 if with_video else 0
    run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            *video_in,
            "-i", str(ref_flac), "-i", str(cand_flac),
            *(["-map", "0:v:0"] if with_video else []),
            "-map", f"{audio_input}:a:0", "-map", f"{audio_input + 1}:a:0",
            *(["-c:v", "copy"] if with_video else []), "-c:a", "flac",
            "-metadata:s:a:0", "language=jpn",
            "-metadata:s:a:1", "language=fre",
            str(out),
        ]
    )
    ref_flac.unlink()
    cand_flac.unlink()


@dataclass
class Fixture:
    name: str
    description: str
    breakpoints: list[Breakpoint] = field(default_factory=list)
    stretch_factor: float | None = None
    candidate: str = "dub"
    # None: the default --duration window; 0: the whole source.
    duration_s: float | None = None

    def window(self, default_duration: float) -> float | None:
        """Extraction length: None means the whole source."""
        if self.duration_s is None:
            return default_duration
        return self.duration_s or None

    def to_manifest(self, default_duration: float, full_duration: float) -> dict:
        return {
            "file": f"{self.name}.mkv",
            "description": self.description,
            "candidate": self.candidate,
            "duration_s": self.window(default_duration) or full_duration,
            "breakpoints": [
                {"time_s": b.time_s, "delta_s": b.delta_s, **({"fill": b.fill} if b.fill != "silence" else {})}
                for b in self.breakpoints
            ],
            "stretch_factor": self.stretch_factor,
        }


def build_fixtures(seed: int) -> list[Fixture]:
    rng = random.Random(seed)
    multi_times = sorted(rng.uniform(45.0, 315.0) for _ in range(3))
    multi_deltas = [rng.choice([-1, 1]) * rng.uniform(1.0, 3.5) for _ in multi_times]

    return [
        Fixture("sync_base", "Temoin : aucune desynchronisation (sanity check, offset attendu = 0)."),
        Fixture(
            "offset_const_plus",
            "Decalage constant : la candidate est en retard de 5s des le debut.",
            breakpoints=[Breakpoint(0.0, 5.0)],
        ),
        Fixture(
            "offset_const_minus",
            "Decalage constant : la candidate est en avance de 3s des le debut.",
            breakpoints=[Breakpoint(0.0, -3.0)],
        ),
        Fixture(
            "jump_single",
            "Synchro au debut, puis un saut net de +4s a t=150s.",
            breakpoints=[Breakpoint(150.0, 4.0)],
        ),
        Fixture(
            "jump_multi",
            f"Plusieurs sauts a des instants pseudo-aleatoires (seed={seed}).",
            breakpoints=[Breakpoint(t, d) for t, d in zip(multi_times, multi_deltas)],
        ),
        Fixture(
            "drift_slower",
            "Derive progressive : la candidate tourne 1% plus lentement (retard croissant).",
            stretch_factor=1.01,
        ),
        Fixture(
            "drift_faster",
            "Derive progressive : la candidate tourne 1% plus vite (avance croissante).",
            stretch_factor=0.99,
        ),
        Fixture("exact_sync", "Verite exacte : reference degradee, aucune desynchronisation.", candidate="reference"),
        Fixture(
            "exact_jump_single",
            "Verite exacte : saut de +4s (silence insere) a t=150s.",
            breakpoints=[Breakpoint(150.0, 4.0)],
            candidate="reference",
        ),
        Fixture(
            "exact_jump_multi",
            "Verite exacte : memes sauts que jump_multi.",
            breakpoints=[Breakpoint(t, d) for t, d in zip(multi_times, multi_deltas)],
            candidate="reference",
        ),
        Fixture(
            "exact_micro_jumps",
            "Verite exacte : micro-sauts de 50 a 250 ms, dans les deux sens.",
            breakpoints=[
                Breakpoint(60.0, 0.08), Breakpoint(140.0, -0.12), Breakpoint(220.0, 0.25), Breakpoint(300.0, -0.05),
            ],
            candidate="reference",
        ),
        Fixture(
            "exact_jump_filled",
            "Verite exacte : +3s de contenu (bruit, pas un blanc) insere a 120s, puis -2s a 240s.",
            breakpoints=[Breakpoint(120.0, 3.0, fill="noise"), Breakpoint(240.0, -2.0)],
            candidate="reference",
        ),
        Fixture(
            "exact_drift_slower",
            "Verite exacte : la candidate tourne 1% plus lentement.",
            stretch_factor=1.01,
            candidate="reference",
        ),
        Fixture(
            "exact_full",
            "Verite exacte, source entiere : sauts de tailles variees, dont un comble par du bruit.",
            breakpoints=[
                Breakpoint(95.0, 2.5),
                Breakpoint(310.0, -1.2),
                Breakpoint(540.0, 0.15),
                Breakpoint(800.0, -0.3),
                Breakpoint(1050.0, 3.0, fill="noise"),
                Breakpoint(1320.0, -0.08),
            ],
            candidate="reference",
            duration_s=0,
        ),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--start", type=float, default=0.0, help="Debut de l'extrait (s).")
    parser.add_argument("--duration", type=float, default=360.0, help="Duree de l'extrait (s).")
    parser.add_argument("--seed", type=int, default=1234, help="Seed pour jump_multi.")
    parser.add_argument("--only", default="", help="Noms de fixtures a (re)generer, separes par des virgules.")
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"Source introuvable : {args.source}")

    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    ffmpeg = resolve_ffmpeg()
    from syncaudio.ffmpeg_backend import probe_duration

    full_duration = probe_duration(str(args.source)) - args.start
    fixtures = build_fixtures(args.seed)
    only = {n for n in args.only.split(",") if n}
    unknown = only - {fx.name for fx in fixtures}
    if unknown:
        raise SystemExit(f"Fixtures inconnues : {sorted(unknown)}")

    resolved_source = args.source.resolve()
    try:
        source_display = resolved_source.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        source_display = resolved_source.name  # hors du repo : ne pas exposer le chemin local

    manifest = {
        "source": source_display,
        "window": {"start_s": args.start, "duration_s": args.duration},
        "reference_track": REFERENCE_TRACK,
        "candidate_track": CANDIDATE_TRACK,
        "offset_sign_convention": "positif = la candidate est en retard sur la reference",
        "fixtures": [fx.to_manifest(args.duration, full_duration) for fx in fixtures],
    }

    extracted: dict[tuple[int, float | None], Path] = {}

    def track_wav(track: int, duration: float | None) -> Path:
        if (track, duration) not in extracted:
            out = GENERATED_DIR / f"_track{track}_{duration or 'full'}.wav"
            print(f"[extraction] piste {track} ({duration or 'entiere'}) ...")
            extract_audio_wav(ffmpeg, args.source, track, args.start, duration, out)
            extracted[(track, duration)] = out
        return extracted[(track, duration)]

    try:
        for fx in fixtures:
            if only and fx.name not in only:
                continue
            print(f"[fixture] {fx.name} : {fx.description}")
            duration = fx.window(args.duration)
            ref_wav = track_wav(REFERENCE_TRACK, duration)
            if fx.candidate == "reference":
                ref_data, sr = read_wav(ref_wav)
                cand_data = degrade(ref_data, sr)
            else:
                cand_data, sr = read_wav(track_wav(CANDIDATE_TRACK, duration))

            if fx.stretch_factor is not None:
                variant = time_stretch(cand_data, fx.stretch_factor)
            elif fx.breakpoints:
                variant = apply_piecewise_offset(cand_data, sr, fx.breakpoints)
            else:
                variant = cand_data

            variant_wav = GENERATED_DIR / f"_{fx.name}_candidate.wav"
            write_wav(variant_wav, variant, sr)
            out_mkv = GENERATED_DIR / f"{fx.name}.mkv"
            mux(ffmpeg, args.source, args.start, duration, ref_wav, variant_wav, out_mkv, with_video=fx.candidate == "dub")
            variant_wav.unlink()
    finally:
        for wav in extracted.values():
            wav.unlink(missing_ok=True)

    manifest_path = FIXTURES_DIR / "MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nTermine. Fixtures dans {GENERATED_DIR}, verite-terrain dans {manifest_path}")


if __name__ == "__main__":
    main()
