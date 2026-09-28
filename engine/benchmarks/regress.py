"""Non-regression + timing harness for the analysis pipeline.

    uv run python benchmarks/regress.py record  # snapshot current outputs
    uv run python benchmarks/regress.py check   # compare against the snapshot

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


def _close(a, b, atol: float) -> bool:
    if isinstance(a, list):
        return len(a) == len(b) and all(_close(x, y, atol) for x, y in zip(a, b))
    if isinstance(a, bool) or atol == 0:
        return a == b
    return abs(a - b) <= atol


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["record", "check"])
    parser.add_argument("--atol", type=float, default=0.0)
    args = parser.parse_args()

    manifest = json.loads((FIXTURES / "MANIFEST.json").read_text(encoding="utf-8"))
    BASELINE.mkdir(parents=True, exist_ok=True)
    failures = 0
    total: dict[str, float] = {}

    for fixture in manifest["fixtures"]:
        name = fixture["file"]
        arrays, results, timings = _run_fixture(FIXTURES / "generated" / name)
        for k, v in timings.items():
            total[k] = total.get(k, 0.0) + v
        timing_str = "  ".join(f"{k}={v:.2f}s" for k, v in timings.items())
        stem = BASELINE / Path(name).stem

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
