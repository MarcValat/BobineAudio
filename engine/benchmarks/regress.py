"""Non-regression + timing harness for the analysis pipeline.

    uv run python benchmarks/regress.py record  # snapshot current outputs
    uv run python benchmarks/regress.py check   # compare against the snapshot
    uv run python benchmarks/regress.py score   # accuracy against the fixtures' ground truth

Runs every fixture in tests/fixtures/generated (see tests/fixtures/MANIFEST.json)
through the real pipeline -- envelopes, constant-offset estimate and segment
detection -- and requires the outputs to be bit-identical to the snapshot
(``--atol`` relaxes that for changes that are knowingly not bit-exact).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

# Measure the real computation, never a previous run's persisted analysis.
os.environ["SYNCAUDIO_CACHE_DIR"] = ""

from syncaudio import analysis_cache
from syncaudio.align import estimate_offset
from syncaudio.analysis_cache import ANALYSIS_SAMPLE_RATE, get_envelope
from syncaudio.models import AudioTrackSpec
from syncaudio.segments import detect_segments

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
BASELINE = ROOT / "benchmarks" / ".baseline"


def _spec(path: Path, index: int) -> AudioTrackSpec:
    return AudioTrackSpec(raw=f"{path}@{index}", path=str(path), stream_index=index)


def _run_fixture(path: Path) -> tuple[dict[str, np.ndarray], dict, dict[str, float]]:
    analysis_cache.clear()
    ref, cand = _spec(path, 0), _spec(path, 1)
    timings: dict[str, float] = {}

    t = time.perf_counter()
    analysis_cache.prefetch([ref, cand], ANALYSIS_SAMPLE_RATE)
    ref_env, frame_rate = get_envelope(ref, ANALYSIS_SAMPLE_RATE)
    cand_env, _ = get_envelope(cand, ANALYSIS_SAMPLE_RATE)
    timings["envelopes"] = time.perf_counter() - t

    t = time.perf_counter()
    est = estimate_offset(ref_env, cand_env, frame_rate)
    timings["align"] = time.perf_counter() - t

    t = time.perf_counter()
    segs = detect_segments(ref, cand)
    timings["segments"] = time.perf_counter() - t

    arrays = {"ref_env": ref_env, "cand_env": cand_env}
    results = {
        "frame_rate": frame_rate,
        "align": [est.offset_seconds, est.confidence, est.ambiguous],
        "segments": [[s.start_s, s.end_s, s.offset_start, s.offset_end, s.confidence] for s in segs],
    }
    return arrays, results, timings


# Beyond this, an offset error starts being noticeable as lip-sync.
_WRONG_OFFSET_S = 0.040


def _synthetic_offset(fixture: dict, t: float) -> float | None:
    """The offset make_fixtures.py added at reference time ``t`` (None: no counterpart).

    A positive delta inserts silence at ``time_s``; a negative one removes
    ``-delta_s`` of candidate content starting there, so that reference span
    has nothing to align to. This is on top of the source tracks' own
    relationship, which is *not* exactly zero: the source dub has small jumps
    of its own (tens of ms), measured here on sync_base.mkv (see ``_run_score``).
    """
    if fixture["stretch_factor"] is not None:
        return (fixture["stretch_factor"] - 1.0) * t
    offset = 0.0
    for bp in fixture["breakpoints"]:
        if t < bp["time_s"]:
            break
        if bp["delta_s"] < 0 and t < bp["time_s"] - bp["delta_s"]:
            return None
        offset += bp["delta_s"]
    return offset


def _offset_at(segments: list, t: float) -> float:
    for start, end, off_start, off_end, _ in segments:
        if t < end:
            frac = 0.0 if end <= start else min(1.0, max(0.0, (t - start) / (end - start)))
            return off_start + frac * (off_end - off_start)
    return segments[-1][3]


def _score(fixture: dict, segments: list, base: list, duration_s: float) -> dict:
    """Base-independent accuracy measures, plus consistency with the measured base.

    - boundary: distance from each synthetic jump to the nearest detected
      boundary (a missing-content jump is right anywhere in its missing span);
    - jump size: detected offset change across that boundary vs. ``delta_s``
      (the base cancels out, unless it jumps right there too);
    - offset: detected offset vs. synthetic + base over the whole timeline.
    """
    boundaries = [s[0] for s in segments[1:]]
    boundary_errs, size_errs = [], []
    for bp in (bp for bp in fixture["breakpoints"] if bp["time_s"] > 0):
        lo, hi = bp["time_s"], bp["time_s"] - min(0.0, bp["delta_s"])
        dist = [max(lo - b, b - hi, 0.0) for b in boundaries]
        if not dist:
            boundary_errs.append(float("inf"))
            continue
        b = boundaries[int(np.argmin(dist))]
        boundary_errs.append(min(dist))
        size = _offset_at(segments, b + 0.01) - _offset_at(segments, b - 0.01)
        size_errs.append(abs(size - bp["delta_s"]))

    errors = []
    for t in np.arange(0.0, duration_s, 0.05):
        synthetic = _synthetic_offset(fixture, float(t))
        if synthetic is not None:
            errors.append(abs(_offset_at(segments, float(t)) - synthetic - _offset_at(base, float(t))))
    errors = np.array(errors)
    return {
        "boundary_s": max(boundary_errs, default=0.0),
        "size_ms": 1000 * max(size_errs, default=0.0),
        "mean_ms": 1000 * errors.mean(),
        "wrong_pct": 100 * (errors > _WRONG_OFFSET_S).mean(),
    }


def _segments_of(path: Path) -> list:
    analysis_cache.clear()
    segs = detect_segments(_spec(path, 0), _spec(path, 1))
    return [[s.start_s, s.end_s, s.offset_start, s.offset_end, s.confidence] for s in segs]


def _run_score(manifest: dict) -> int:
    fixtures = manifest["fixtures"]
    dub_base = next(
        f for f in fixtures if f.get("candidate", "dub") == "dub" and not f["breakpoints"] and f["stretch_factor"] is None
    )
    base = _segments_of(FIXTURES / "generated" / dub_base["file"])
    print(f"base du doublage, mesuree sur {dub_base['file']} (les fixtures exact_* ont une base nulle) :")
    for start, end, a, b, conf in base:
        print(f"    {start:7.2f}s -> {end:7.2f}s  {1000 * a:+7.1f} -> {1000 * b:+7.1f} ms  (confiance {conf:.2f})")
    print()
    print(f"{'fixture':24s} {'segs':>5s} {'frontiere':>10s} {'taille saut':>12s} {'err moy':>9s} {'>40ms':>7s}")
    for fixture in fixtures:
        if fixture is dub_base:
            continue
        exact = fixture.get("candidate") == "reference"
        fixture_base = [[0.0, float("inf"), 0.0, 0.0, 1.0]] if exact else base
        duration = fixture.get("duration_s", manifest["window"]["duration_s"])
        segs = _segments_of(FIXTURES / "generated" / fixture["file"])
        jumps = sum(1 for bp in fixture["breakpoints"] if bp["time_s"] > 0)
        sc = _score(fixture, segs, fixture_base, duration)
        print(
            f"{fixture['file']:24s} {len(segs):>2d}/{len(fixture_base) + jumps:<2d} {sc['boundary_s']:9.3f}s"
            f" {sc['size_ms']:9.1f} ms {sc['mean_ms']:7.1f}ms {sc['wrong_pct']:6.1f}%"
        )
    return 0


def _close(a, b, atol: float) -> bool:
    if isinstance(a, list):
        return len(a) == len(b) and all(_close(x, y, atol) for x, y in zip(a, b))
    if isinstance(a, bool) or atol == 0:
        return a == b
    return abs(a - b) <= atol


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["record", "check", "score"])
    parser.add_argument("--atol", type=float, default=0.0)
    args = parser.parse_args()

    manifest = json.loads((FIXTURES / "MANIFEST.json").read_text(encoding="utf-8"))
    if args.mode == "score":
        return _run_score(manifest)
    BASELINE.mkdir(parents=True, exist_ok=True)
    failures = 0
    total: dict[str, float] = {}

    for fixture in manifest["fixtures"]:
        name = fixture["file"]
        stem = BASELINE / Path(name).stem
        if args.mode == "check" and not Path(f"{stem}.json").exists():
            print(f"[skip] {name}  (absente de l'instantane)")
            continue
        arrays, results, timings = _run_fixture(FIXTURES / "generated" / name)
        for k, v in timings.items():
            total[k] = total.get(k, 0.0) + v
        timing_str = "  ".join(f"{k}={v:.2f}s" for k, v in timings.items())

        if args.mode == "record":
            np.savez(f"{stem}.npz", **arrays)
            Path(f"{stem}.json").write_text(json.dumps({"results": results, "timings": timings}, indent=1))
            print(f"[record] {name}  {timing_str}")
            continue

        base_arrays = np.load(f"{stem}.npz")
        base = json.loads(Path(f"{stem}.json").read_text())
        problems = []
        for k, v in arrays.items():
            b = base_arrays[k]
            if v.shape != b.shape:
                problems.append(f"{k} shape {v.shape} != {b.shape}")
            elif args.atol == 0 and not np.array_equal(v, b):
                problems.append(f"{k} differs (max abs {np.abs(v - b).max():.3g})")
            elif args.atol and not np.allclose(v, b, rtol=0, atol=args.atol * max(1.0, np.abs(b).max())):
                problems.append(f"{k} beyond tolerance (max abs {np.abs(v - b).max():.3g})")
        for k in ("frame_rate", "align", "segments"):
            if not _close(results[k], base["results"][k], args.atol):
                problems.append(f"{k}: {results[k]} != {base['results'][k]}")
        speedups = "  ".join(f"{k}={base['timings'][k] / max(v, 1e-9):.1f}x" for k, v in timings.items())
        status = "OK  " if not problems else "FAIL"
        failures += bool(problems)
        print(f"[{status}] {name}  {timing_str}  (vs baseline: {speedups})")
        for p in problems:
            print(f"        {p}")

    print("total  " + "  ".join(f"{k}={v:.2f}s" for k, v in total.items()))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
