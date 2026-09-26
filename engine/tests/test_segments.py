from __future__ import annotations

import numpy as np

from syncaudio.features import extract_envelope
from syncaudio.segments import WindowOffset, classify_segments, refine_segments, windowed_offsets

SAMPLE_RATE = 16000


def _make_bed(duration_s: float, sr: int, seed: int, hits_per_second: float = 3.0) -> np.ndarray:
    """Percussive-ish "music/SFX bed", same shape as the one in test_align.py."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    bed = np.zeros(n, dtype=np.float64)
    burst_len = int(0.05 * sr)
    envelope = np.hanning(burst_len)
    hit_times = rng.uniform(0, duration_s - 0.2, int(duration_s * hits_per_second))
    for t in hit_times:
        start = int(t * sr)
        if start + burst_len > n:
            continue
        bed[start : start + burst_len] += rng.standard_normal(burst_len) * envelope
    return bed


def _make_dialogue(duration_s: float, sr: int, seed: int, words_per_second: float = 1.5) -> np.ndarray:
    """Independent, voice-like content -- same shape as the one in test_align.py."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    signal = np.zeros(n, dtype=np.float64)
    word_times = rng.uniform(0, duration_s - 0.5, int(duration_s * words_per_second))
    for t in word_times:
        start = int(t * sr)
        length = int(rng.uniform(0.08, 0.35) * sr)
        if start + length > n:
            continue
        local_t = np.arange(length) / sr
        freqs = rng.uniform(120, 700, rng.integers(2, 5))
        phases = rng.uniform(0, 2 * np.pi, len(freqs))
        tone = sum(np.sin(2 * np.pi * f * local_t + p) for f, p in zip(freqs, phases))
        envelope = np.hanning(length)
        gain = rng.uniform(0.15, 0.45)
        signal[start : start + length] += gain * tone * envelope
    return signal


def _apply_jump(bed: np.ndarray, sr: int, jump_time_s: float, delta_s: float) -> np.ndarray:
    idx = int(jump_time_s * sr)
    if delta_s > 0:
        silence = np.zeros(int(delta_s * sr))
        return np.concatenate([bed[:idx], silence, bed[idx:]])
    cut = int(-delta_s * sr)
    return np.concatenate([bed[:idx], bed[idx + cut :]])


def _time_stretch(signal: np.ndarray, factor: float) -> np.ndarray:
    n = len(signal)
    new_n = int(round(n * factor))
    old_idx = np.linspace(0, n - 1, new_n)
    return np.interp(old_idx, np.arange(n), signal)


def test_windowed_offsets_recovers_constant_offset() -> None:
    duration_s = 120.0
    offset_s = 2.0
    bed = _make_bed(duration_s, SAMPLE_RATE, seed=1)
    shifted = np.concatenate([np.zeros(int(offset_s * SAMPLE_RATE)), bed])[: len(bed)]

    reference = bed + _make_dialogue(duration_s, SAMPLE_RATE, seed=2)
    candidate = shifted + _make_dialogue(duration_s, SAMPLE_RATE, seed=3)

    ref_env, frame_rate = extract_envelope(reference, SAMPLE_RATE)
    cand_env, _ = extract_envelope(candidate, SAMPLE_RATE)

    windows = windowed_offsets(ref_env, cand_env, frame_rate)
    assert len(windows) >= 5
    for w in windows:
        assert abs(w.offset_seconds - offset_s) < 0.3

    segments = classify_segments(windows, duration_s)
    assert len(segments) == 1
    assert not segments[0].is_drift
    assert abs(segments[0].mean_offset - offset_s) < 0.3


def test_classify_segments_detects_a_jump() -> None:
    duration_s = 120.0
    jump_time_s = 60.0
    delta_s = 3.0

    bed = _make_bed(duration_s + delta_s, SAMPLE_RATE, seed=10)
    reference_bed = bed[: int(duration_s * SAMPLE_RATE)]
    candidate_bed = _apply_jump(bed, SAMPLE_RATE, jump_time_s, delta_s)[: int(duration_s * SAMPLE_RATE)]

    reference = reference_bed + _make_dialogue(duration_s, SAMPLE_RATE, seed=11)
    candidate = candidate_bed + _make_dialogue(duration_s, SAMPLE_RATE, seed=12)

    ref_env, frame_rate = extract_envelope(reference, SAMPLE_RATE)
    cand_env, _ = extract_envelope(candidate, SAMPLE_RATE)

    windows = windowed_offsets(ref_env, cand_env, frame_rate)
    segments = classify_segments(windows, duration_s)

    assert len(segments) == 2
    assert abs(segments[0].mean_offset - 0.0) < 0.3
    assert abs(segments[1].mean_offset - delta_s) < 0.3
    coarse_error = abs(segments[0].end_s - jump_time_s)
    assert coarse_error < 20.0  # boundary precision is on the order of window_s

    refined = refine_segments(ref_env, cand_env, frame_rate, segments)
    assert len(refined) == 2
    refined_error = abs(refined[0].end_s - jump_time_s)
    assert refined_error < 5.0
    assert refined_error <= coarse_error


def test_classify_segments_ignores_an_isolated_outlier_window() -> None:
    """Real bug report: a single window (or two) reads a wildly different
    offset than every neighbour on both sides -- a locally
    ambiguous/aliased correlation lock, not a real jump-and-back -- and used
    to come back as its own spurious mini-segment. A real jump persists
    across many consecutive windows; this constructs windows directly
    (bypassing audio synthesis entirely) to isolate exactly that one
    failure shape."""
    hop_s = 10.0
    n_windows = 20
    windows = [WindowOffset(time_s=i * hop_s, offset_seconds=0.02 * ((i % 5) - 2), confidence=0.5, ambiguous=False) for i in range(n_windows)]
    # Two consecutive outlier windows in the middle, clearly past the jump
    # threshold, surrounded on both sides by windows that agree with each
    # other -- matches the reported case (a ~20s spurious segment amid an
    # otherwise-flat multi-minute track).
    outlier_at = n_windows // 2
    windows[outlier_at] = WindowOffset(time_s=outlier_at * hop_s, offset_seconds=-1.71, confidence=0.5, ambiguous=False)
    windows[outlier_at + 1] = WindowOffset(time_s=(outlier_at + 1) * hop_s, offset_seconds=-1.71, confidence=0.5, ambiguous=False)

    segments = classify_segments(windows, total_duration_s=n_windows * hop_s)

    assert len(segments) == 1
    assert not segments[0].is_drift
    assert abs(segments[0].mean_offset) < 0.3


def test_classify_segments_does_not_extrapolate_an_insignificant_slope() -> None:
    """Real bug report: pure per-window noise around an otherwise-flat true
    offset produced a technically-nonzero least-squares fit whose
    *extrapolated* endpoints (offset_start ~+0.22s, offset_end ~-0.03s over
    a ~24-minute segment) looked like real drift and shifted+re-corrected
    audio for nothing. These windows have no real trend at all -- any
    apparent slope is pure noise -- so classify_segments should report a
    flat, near-constant segment instead of extrapolating it end to end."""
    hop_s = 10.0
    n_windows = 142  # ~1420s at a 10s hop, matching the real report's duration
    true_offset = 0.1
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 0.12, n_windows)
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=true_offset + noise[i], confidence=0.5, ambiguous=False)
        for i in range(n_windows)
    ]

    segments = classify_segments(windows, total_duration_s=n_windows * hop_s)

    assert len(segments) == 1
    assert not segments[0].is_drift
    assert abs(segments[0].mean_offset - true_offset) < 0.15


def test_classify_segments_detects_drift() -> None:
    duration_s = 120.0
    stretch_factor = 1.02  # candidate ~2% slower -> lag grows to roughly 2.3s

    bed = _make_bed(duration_s, SAMPLE_RATE, seed=20)
    stretched = _time_stretch(bed, stretch_factor)[: len(bed)]

    reference = bed + _make_dialogue(duration_s, SAMPLE_RATE, seed=21)
    candidate = stretched + _make_dialogue(duration_s, SAMPLE_RATE, seed=22)

    ref_env, frame_rate = extract_envelope(reference, SAMPLE_RATE)
    cand_env, _ = extract_envelope(candidate, SAMPLE_RATE)

    windows = windowed_offsets(ref_env, cand_env, frame_rate)
    segments = classify_segments(windows, duration_s)

    assert len(segments) == 1
    assert segments[0].is_drift
    assert abs(segments[0].offset_start - 0.0) < 0.5
    expected_end = duration_s * (1 - 1 / stretch_factor)
    assert abs(segments[0].offset_end - expected_end) < 0.6
