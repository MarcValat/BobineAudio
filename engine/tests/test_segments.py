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
    assert abs(refined[0].end_s - jump_time_s) < 0.1


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
    assert segments[0].confidence > 0.5  # a real drift must not be flagged as unreliable


def test_confidence_is_high_for_a_well_supported_segment() -> None:
    hop_s = 10.0
    n_windows = 20
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=0.01 * ((i % 5) - 2), confidence=0.8, ambiguous=False)
        for i in range(n_windows)
    ]

    segments = classify_segments(windows, total_duration_s=n_windows * hop_s)

    assert len(segments) == 1
    assert segments[0].confidence > 0.7


def test_confidence_is_low_for_a_small_trailing_group_even_when_it_agrees_with_itself() -> None:
    """Real bug shape: a spurious tail segment carried by only a handful of
    windows that happen to agree with each other perfectly -- which proves
    very little (a line always fits 1-2 points closely) -- shouldn't be
    trusted just because of that agreement. Confidence must reflect the
    weak sample size even when there's zero internal scatter to otherwise
    penalize."""
    hop_s = 10.0
    n_lead = 16
    n_tail = 2
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=0.01 * ((i % 5) - 2), confidence=0.8, ambiguous=False)
        for i in range(n_lead)
    ]
    windows += [
        WindowOffset(time_s=(n_lead + i) * hop_s, offset_seconds=1.5, confidence=0.8, ambiguous=False)
        for i in range(n_tail)
    ]

    segments = classify_segments(windows, total_duration_s=(n_lead + n_tail) * hop_s)

    assert len(segments) == 2
    assert segments[0].confidence > 0.7
    assert segments[1].confidence < 0.5
    assert segments[1].confidence < segments[0].confidence


def test_confidence_is_low_for_a_segment_whose_windows_disagree_with_each_other() -> None:
    """The other half of the formula, and the actual reported bug: a
    segment with *plenty* of supporting windows (well past
    _CONFIDENT_WINDOW_COUNT) can still be untrustworthy if those windows
    don't agree with each other. Alternating +/-0.35 (not random noise, so
    the math below is exact, not luck-of-the-seed): every individual jump
    is only 0.7s, under the 0.75s jump threshold and the outlier filter's
    tolerance (so this stays one segment), and the single-line fit's max
    residual is 0.35s, under _RESIDUAL_TOL_S (0.4)."""
    hop_s = 10.0
    n_windows = 22
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=0.35 if i % 2 == 0 else -0.35, confidence=0.8, ambiguous=False)
        for i in range(n_windows)
    ]

    segments = classify_segments(windows, total_duration_s=n_windows * hop_s)

    assert len(segments) == 1
    # robust sigma = 1.4826 * 0.35 ~= 0.52, se = 0.52 / sqrt(22) ~= 0.11,
    # precision = 1 - 0.11 / 0.15 ~= 0.26
    assert segments[0].confidence < 0.3


def test_straggler_seeded_group_is_merged_back_instead_of_becoming_a_fake_drift() -> None:
    """Real reported case (E02): one straggler window, just inside the
    outlier filter's tolerance, started a new group; every later window
    joined it, so two groups described the same offset (both medians
    -0.969s) and the second one's line fit, pulled by its seed, came out
    as a fake -1.26s -> -0.81s drift. Modelled here: a constant track with
    one 0.8s straggler that the outlier filter narrowly keeps."""
    hop_s = 10.0
    offsets = [0.0] * 16 + [0.8, 0.2, 0.1] + [0.0] * 8
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=o, confidence=0.5, ambiguous=False) for i, o in enumerate(offsets)
    ]

    segments = classify_segments(windows, total_duration_s=len(offsets) * hop_s)

    assert len(segments) == 1
    assert not segments[0].is_drift
    assert abs(segments[0].offset_start) < 0.05
    assert abs(segments[0].offset_end) < 0.05
    assert segments[0].confidence > 0.9


def test_stragglers_at_one_end_do_not_tilt_a_constant_segment() -> None:
    """Real reported case (E02 again, once merged): nearly every window
    exactly on -0.969s, a few stragglers late in the file between -1.1 and
    -1.4s -- least squares came out as -0.957s -> -1.039s even though the
    median was -0.969s everywhere. The robust fit must stay on it."""
    hop_s = 10.0
    offsets = [-0.97] * 100 + [-1.41, -1.42, -0.97, -1.18, -1.10, -0.97, -1.24] + [-0.97] * 10
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=o, confidence=0.5, ambiguous=False) for i, o in enumerate(offsets)
    ]

    segments = classify_segments(windows, total_duration_s=len(offsets) * hop_s)

    assert len(segments) == 1
    assert abs(segments[0].offset_start - -0.97) < 0.01
    assert abs(segments[0].offset_end - -0.97) < 0.01
    assert segments[0].confidence > 0.9


def test_confidence_is_high_despite_low_raw_window_confidence_when_windows_agree() -> None:
    """Real bug report: a visibly correct, dead-flat ~20-minute segment
    still averaged only ~2% *raw* per-window confidence (that statistic
    genuinely does run low on real dialogue/SFX content -- see
    _segment_confidence's docstring) -- confirming a segment's confidence
    must be driven by inter-window agreement, not each window's own,
    already-known-unreliable-in-isolation z-score."""
    hop_s = 10.0
    n_windows = 20
    windows = [
        WindowOffset(time_s=i * hop_s, offset_seconds=0.01 * ((i % 5) - 2), confidence=0.02, ambiguous=False)
        for i in range(n_windows)
    ]

    segments = classify_segments(windows, total_duration_s=n_windows * hop_s)

    assert len(segments) == 1
    assert segments[0].confidence > 0.7


def _energy_from(reference: np.ndarray, candidate: np.ndarray, frame_rate: float):
    hop = int(round(SAMPLE_RATE / frame_rate))

    def read(role: str, start_s: float, duration_s: float) -> np.ndarray:
        pcm = reference if role == "ref" else candidate
        first = int(round(start_s * frame_rate))
        out = np.zeros(int(np.ceil(duration_s * frame_rate)))
        for i in range(len(out)):
            a = (first + i) * hop
            if 0 <= a and a + hop <= len(pcm):
                out[i] = np.sqrt(np.mean(pcm[a : a + hop] ** 2))
        return out

    return read


def test_a_blank_inserted_in_a_dialogue_stretch_is_cut_exactly() -> None:
    """Around the jump the shared bed goes quiet (dialogue only, which
    differs between the tracks): correlation alone can't place the split
    there, the inserted blank in the candidate can."""
    duration_s, jump_s, delta_s = 120.0, 60.0, 3.0
    bed = _make_bed(duration_s + delta_s, SAMPLE_RATE, seed=20)
    quiet = slice(int((jump_s - 6) * SAMPLE_RATE), int((jump_s + 6) * SAMPLE_RATE))
    bed[quiet] = 0.0
    reference = bed[: int(duration_s * SAMPLE_RATE)] + _make_dialogue(duration_s, SAMPLE_RATE, seed=21)
    cand_bed = bed + _make_dialogue(duration_s + delta_s, SAMPLE_RATE, seed=22)
    candidate = _apply_jump(cand_bed, SAMPLE_RATE, jump_s, delta_s)[: int(duration_s * SAMPLE_RATE)]

    ref_env, frame_rate = extract_envelope(reference, SAMPLE_RATE)
    cand_env, _ = extract_envelope(candidate, SAMPLE_RATE)
    segments = classify_segments(windowed_offsets(ref_env, cand_env, frame_rate), duration_s)
    assert len(segments) == 2

    refined = refine_segments(
        ref_env, cand_env, frame_rate, segments, energy=_energy_from(reference, candidate, frame_rate)
    )
    cut = refined[0].end_s
    assert abs(cut - jump_s) < 0.5
    # Wherever it lands exactly, what it removes from the candidate must be
    # the blank (the synthetic content has natural silent gaps, so a few cut
    # points remove near-identical silence, give or take a frame's edge).
    removed = candidate[int(round(cut * SAMPLE_RATE)) : int(round((cut + delta_s) * SAMPLE_RATE))]
    assert np.sqrt(np.mean(removed**2)) < 0.01 * np.sqrt(np.mean(candidate**2))


def _windows(offsets: list[float], hop_s: float = 10.0) -> list[WindowOffset]:
    return [WindowOffset(time_s=i * hop_s, offset_seconds=o, confidence=0.5, ambiguous=False) for i, o in enumerate(offsets)]


def test_small_jumps_of_tens_of_ms_are_segments_of_their_own() -> None:
    """Real dubs drift by a few tens of ms from scene to scene (the
    fixtures' source: +47ms, then -36ms, then -115ms)."""
    rng = np.random.default_rng(3)
    levels = [0.047] * 8 + [-0.036] * 8 + [-0.115] * 6
    windows = _windows([o + rng.normal(0, 0.001) for o in levels])

    segments = classify_segments(windows, total_duration_s=len(levels) * 10.0)

    assert [round(s.mean_offset, 3) for s in segments] == [0.047, -0.036, -0.115]


def test_a_blip_next_to_a_small_jump_does_not_hide_it() -> None:
    """Also from the fixtures' source: two stray windows 0.2s off, right
    before the +47 -> -36ms change."""
    levels = [0.047] * 10 + [0.253, 0.259] + [0.047] * 3 + [-0.036] * 10
    segments = classify_segments(_windows(levels), total_duration_s=len(levels) * 10.0)

    assert len(segments) == 2
    assert abs(segments[0].mean_offset - 0.047) < 0.002
    assert abs(segments[1].mean_offset - -0.036) < 0.002


def test_a_small_jump_needs_several_windows_on_each_side() -> None:
    levels = [0.0] * 12 + [0.05, 0.05] + [0.0] * 12
    assert len(classify_segments(_windows(levels), total_duration_s=len(levels) * 10.0)) == 1


def test_drift_is_measured_precisely_once_compensated() -> None:
    """Under 1% drift a 30s window's content slides 0.3s: uncompensated
    estimates scatter by a good part of that."""
    from syncaudio.segments import compensate_drift

    duration_s, factor = 180.0, 1.01
    bed = _make_bed(duration_s * factor, SAMPLE_RATE, seed=30)
    reference = bed[: int(duration_s * SAMPLE_RATE)] + _make_dialogue(duration_s, SAMPLE_RATE, seed=31)
    candidate = _time_stretch(bed[: int(duration_s * SAMPLE_RATE)], factor) + _make_dialogue(
        duration_s * factor, SAMPLE_RATE, seed=32
    )[: int(round(duration_s * SAMPLE_RATE * factor))]

    ref_env, frame_rate = extract_envelope(reference, SAMPLE_RATE)
    cand_env, _ = extract_envelope(candidate, SAMPLE_RATE)
    args = {"window_s": 30.0, "hop_s": 10.0, "margin_s": 8.0}
    windows = compensate_drift(ref_env, cand_env, frame_rate, windowed_offsets(ref_env, cand_env, frame_rate, **args), **args)
    usable = [w for w in windows if not w.ambiguous]

    errors = [abs(w.offset_seconds - (factor - 1.0) * w.center_s) for w in usable]
    assert np.median(errors) < 0.01
    segments = classify_segments(windows, duration_s)
    assert len(segments) == 1 and segments[0].is_drift
    assert abs(segments[0].offset_end - (factor - 1.0) * duration_s) < 0.03
