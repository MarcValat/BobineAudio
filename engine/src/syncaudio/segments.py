from __future__ import annotations

import dataclasses
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import median_filter

from syncaudio.align import estimate_offset
from syncaudio.analysis_cache import ANALYSIS_SAMPLE_RATE, get_envelope
from syncaudio.ffmpeg_backend import extract_pcm
from syncaudio.models import AudioTrackSpec

DEFAULT_WINDOW_S = 30.0
DEFAULT_HOP_S = 10.0
DEFAULT_MARGIN_S = 8.0

# How far around a coarse boundary refine_boundary searches: a coarse window
# straddles up to a whole DEFAULT_WINDOW_S of mixed before/after content
# near the true jump, which is what limits the coarse pass's precision.
_REFINE_ZOOM_S = 45.0

# A jump between consecutive windows bigger than this (and sustained, not a
# one-window blip) starts a new segment.
_JUMP_THRESHOLD_S = 0.75
# If a single line fits every window within this tolerance, the whole track
# is one segment (constant offset or pure drift) rather than several. Looser
# than a single global estimate's precision: each window sees far less audio
# than a full-track analysis, so its own estimate is noisier.
_RESIDUAL_TOL_S = 0.4
# Below this spread between a segment's start/end offset, treat it as a
# constant shift rather than drift (looser than render.py's threshold: these
# per-window estimates come from shorter, noisier slices).
_DRIFT_EPS_S = 0.2
# Median-filter size used to flag and drop individual outlier windows before
# classification (see classify_segments): catches up to 2 consecutive
# outliers -- a locally ambiguous/aliased correlation lock the `ambiguous`
# flag doesn't catch -- that would otherwise read as a jump away and
# immediately back, emitting a spurious ~1-2-window segment in content
# that's actually one continuous segment (the real bug report this fixes: a
# ~20s spurious segment, i.e. 2 windows at the default 10s hop). 5 needs a
# majority (3 of 5) of neighbours to agree, so it never flags a real,
# sustained jump: one lasting under ~3 windows is already past the coarse
# pass's own documented boundary-precision floor (see
# test_classify_segments_detects_a_jump), so nothing reliably detectable is
# being traded away.
_OUTLIER_FILTER_SIZE = 5
# A segment's confidence (see _segment_confidence) is discounted below this
# many supporting windows -- a handful of windows can agree with each other
# by chance (a small group's own line/mean always fits it reasonably
# tightly, that alone proves nothing). Matches _OUTLIER_FILTER_SIZE's
# neighbourhood size, the smallest sample already treated as meaningful
# elsewhere in this file.
_CONFIDENT_WINDOW_COUNT = 5
# Robust standard error of a segment's offset (see _segment_confidence) at
# which its precision factor reaches 0 -- an offset only known to within
# +/-0.15s isn't usable as a correction. Measured: real, correct segments
# on actual episodes sit at 0.0002-0.003s (~99-100%); a real but noisy
# synthetic drift (8 usable windows, ~0.2s per-window scatter) at ~0.07s
# (~53%) -- a tighter scale (0.05s was tried) flagged that one as 0%.
_PRECISION_SCALE_S = 0.15


@dataclass(frozen=True)
class WindowOffset:
    """Offset estimate local to one time window (see ``windowed_offsets``)."""

    time_s: float
    offset_seconds: float
    confidence: float
    ambiguous: bool


def windowed_offsets(
    ref_env: np.ndarray,
    cand_env: np.ndarray,
    frame_rate: float,
    *,
    window_s: float = DEFAULT_WINDOW_S,
    hop_s: float = DEFAULT_HOP_S,
    margin_s: float = DEFAULT_MARGIN_S,
    search_start_s: float = 0.0,
    search_end_s: float | None = None,
) -> list[WindowOffset]:
    """Slide a window across the reference envelope, estimating a local offset in each.

    Unlike a single global ``estimate_offset`` call (which assumes one
    constant offset for the whole track), this recovers how the offset
    *changes over time* -- the building block for detecting drift (a
    steadily changing offset) and discontinuous jumps (a suddenly changing
    one), rather than just a single constant shift.

    Each reference window of ``window_s`` seconds is searched against a
    *wider* candidate window (padded by ``margin_s`` on each side), so a
    local offset up to ``margin_s`` away from zero can still be found even
    though the two envelopes are sliced independently per window.

    ``search_start_s``/``search_end_s`` restrict where windows are placed
    (default: the whole track) -- used to re-run this locally, at a finer
    resolution, around a boundary already found by a coarser pass (see
    ``refine_segments``) instead of paying that resolution everywhere.
    """
    window_frames = int(round(window_s * frame_rate))
    hop_frames = int(round(hop_s * frame_rate))
    margin_frames = int(round(margin_s * frame_rate))
    n_ref = len(ref_env)
    end_frame = n_ref if search_end_s is None else min(n_ref, int(round(search_end_s * frame_rate)))

    results: list[WindowOffset] = []
    i = int(round(search_start_s * frame_rate))
    while i + window_frames <= end_frame:
        ref_slice = ref_env[i : i + window_frames]
        cand_start = max(0, i - margin_frames)
        cand_end = min(len(cand_env), i + window_frames + margin_frames)
        cand_slice = cand_env[cand_start:cand_end]

        if cand_slice.size >= window_frames:
            estimate = estimate_offset(ref_slice, cand_slice, frame_rate)
            # estimate_offset assumes both slices start at the same instant;
            # cand_slice actually starts (cand_start - i) frames away from
            # ref_slice, so that difference has to be added back in.
            true_offset = estimate.offset_seconds + (cand_start - i) / frame_rate
            results.append(
                WindowOffset(
                    time_s=i / frame_rate,
                    offset_seconds=true_offset,
                    confidence=estimate.confidence,
                    ambiguous=estimate.ambiguous,
                )
            )
        i += hop_frames
    return results


@dataclass(frozen=True)
class Segment:
    """One piece of the timeline with its own correction.

    ``offset_start``/``offset_end`` are the candidate's offset (same sign
    convention as ``estimate_offset``: positive = lags) at the start/end of
    this segment. Equal (within ``_DRIFT_EPS_S``) means a constant shift
    (pad/trim, as in ``render.correction_filter``); different means linear
    drift across the segment (needs a time-stretch, not yet implemented).
    """

    start_s: float
    end_s: float
    offset_start: float
    offset_end: float
    # How much this segment's classification/offsets should be trusted, in
    # [0, 1] -- see _segment_confidence. Defaulted so every existing
    # 4-positional-arg call site (tests, render.py's own construction of
    # ad-hoc segments, SegmentOut.to_segment for a manually-edited segment
    # sent back from the GUI) keeps working unchanged; render itself never
    # reads this, it's purely for the GUI to surface.
    confidence: float = 1.0

    @property
    def is_drift(self) -> bool:
        return abs(self.offset_end - self.offset_start) > _DRIFT_EPS_S

    @property
    def mean_offset(self) -> float:
        return (self.offset_start + self.offset_end) / 2.0


def _theil_sen_slope(times: np.ndarray, offsets: np.ndarray) -> float:
    """Median of every pairwise slope -- a line fit that a few outlying
    windows can't drag around (unlike least squares, where one extreme
    point at a segment's edge can single-handedly tilt the whole line).
    Hand-rolled rather than scipy.stats.theilslopes to avoid importing
    scipy.stats (a noticeable extra cost at engine startup) for ~10k
    pairwise divisions at most."""
    i, j = np.triu_indices(len(times), k=1)
    dt = times[j] - times[i]
    valid = dt != 0
    if not valid.any():
        return 0.0
    return float(np.median((offsets[j] - offsets[i])[valid] / dt[valid]))


def _fit_line_or_constant(times: np.ndarray, offsets: np.ndarray) -> tuple[float, float]:
    """Robust (slope, intercept) for ``offsets`` vs ``times`` -- Theil-Sen
    slope, median intercept -- with the slope zeroed out (falling back to
    the plain median, a pure constant) when it isn't statistically
    distinguishable from the noise around it.

    Robust rather than least squares because of what per-window offset
    errors actually look like on real episodes: the overwhelming majority
    of windows land on the exact same value, plus a few isolated stragglers
    off by 0.1-0.9s. Least squares lets those few stragglers tilt the line
    (a real reported case: a segment whose median was -0.969s at every
    point came out as -0.957s -> -1.039s); Theil-Sen/median ignore them.

    Why this matters: only the *endpoint* values (``offset_start``/
    ``offset_end``, i.e. the fitted line evaluated at the segment's actual
    start/end) ever get shown or used for correction -- and those endpoints
    are usually an *extrapolation* past the fitted windows' own time range
    (a segment's boundaries come from jump detection/segment edges, not from
    where the first/last window happened to land). A small, statistically
    meaningless slope, extrapolated across a long segment, swings from one
    visible value at the start to a different one at the end even though
    the true offset never moved -- reported directly: a ~23-minute segment
    whose per-window noise alone spans barely 0.25s got shown (and
    corrected) as "starts at +0.22s, ends at -0.03s" purely from that
    extrapolation, when the true offset was plausibly constant throughout.
    """
    n = len(times)
    median_offset = float(np.median(offsets))
    if n < 3:
        return 0.0, median_offset
    time_spread = float(np.sum((times - times.mean()) ** 2))
    if time_spread <= 0:
        return 0.0, median_offset
    slope = _theil_sen_slope(times, offsets)
    intercept = float(np.median(offsets - slope * times))
    residuals = offsets - (intercept + slope * times)
    robust_sigma = 1.4826 * float(np.median(np.abs(residuals - np.median(residuals))))
    slope_se = robust_sigma / time_spread**0.5
    # ~1.5 standard errors, not the usual 2 (~95% confidence): these are
    # already noisy per-window estimates (see _RESIDUAL_TOL_S), so leaning
    # slightly further towards "probably not real drift" is the safer
    # default -- an unnecessary near-zero atempo is harmless, but a spurious
    # one shifts audio at one end of the segment for nothing. slope_se == 0
    # (every window exactly on the line) with a nonzero slope is a perfect
    # fit, i.e. maximally significant, not degenerate.
    if slope == 0.0 or abs(slope) < 1.5 * slope_se:
        return 0.0, median_offset
    return slope, intercept


def _segment_confidence(
    group: Sequence[WindowOffset], start_s: float, end_s: float, offset_start: float, offset_end: float
) -> float:
    """How much a segment's reported correction should be trusted, in [0, 1].

    Deliberately *not* built from each window's own correlation confidence
    (``estimate_offset``'s peak-prominence z-score): that statistic runs low
    even for a correct estimate on real dialogue/SFX content -- a visibly
    dead-flat, confirmed-correct ~20-minute segment averaged ~2%. And
    deliberately *robust* (MAD) rather than RMS, for the same reason the fit
    itself is (see _fit_line_or_constant): an RMS is dominated by a correct
    segment's handful of stragglers, capping obviously-perfect segments
    around 75-85%. Two factors:

    - Sample size: discounted below ``_CONFIDENT_WINDOW_COUNT`` -- a line
      always fits 1-2 points closely, that proves nothing.
    - Precision: the robust standard error of the segment's offset
      (1.4826*MAD of residuals around the reported line / sqrt(n)) against
      ``_PRECISION_SCALE_S`` -- low when the windows genuinely disagree with
      each other, not just when a couple of them are off.
    """
    n = len(group)
    sample_factor = min(1.0, n / _CONFIDENT_WINDOW_COUNT)
    if n < 2:
        return sample_factor

    times = np.array([w.time_s for w in group])
    offsets = np.array([w.offset_seconds for w in group])
    span = end_s - start_s
    slope = (offset_end - offset_start) / span if span > 0 else 0.0
    residuals = offsets - (offset_start + slope * (times - start_s))
    robust_sigma = 1.4826 * float(np.median(np.abs(residuals - np.median(residuals))))
    precision = max(0.0, 1.0 - (robust_sigma / n**0.5) / _PRECISION_SCALE_S)
    return float(sample_factor * precision)


def classify_segments(
    windows: Sequence[WindowOffset],
    total_duration_s: float,
    *,
    jump_threshold_s: float = _JUMP_THRESHOLD_S,
    residual_tol_s: float = _RESIDUAL_TOL_S,
) -> list[Segment]:
    """Turn a windowed offset series into a small number of correction segments.

    ``ambiguous`` windows (competing correlation peak -- see ``align.py``) are
    excluded from deciding both the linear fit and the jump boundaries: at
    the window scale, real content residuals mean *confidence* alone stays
    low even for correct estimates (see README caveats), so ``ambiguous`` is
    used as the reliability signal instead of a confidence threshold for
    *that* decision. Each returned segment still carries its own aggregate
    ``confidence`` (see ``_segment_confidence``) -- unlike a single window's,
    that one *is* meant to be read and acted on (the GUI's manual editor
    surfaces it and can bulk-discard low-confidence segments).

    First tries a single line through every usable window; if that already
    explains the data within ``residual_tol_s``, the whole track is one
    segment (flat = constant offset, sloped = pure drift). Otherwise, splits
    into segments wherever the offset jumps by more than ``jump_threshold_s``
    and stays there, fitting a line within each.
    """
    usable = [w for w in windows if not w.ambiguous]
    if len(usable) < 2:
        usable = list(windows)
    if not usable:
        return [Segment(0.0, total_duration_s, 0.0, 0.0, confidence=0.0)]

    times = np.array([w.time_s for w in usable])
    offsets = np.array([w.offset_seconds for w in usable])

    # Drop individual outlier windows entirely before doing anything else --
    # a locally ambiguous/aliased correlation lock the `ambiguous` flag
    # doesn't catch, flagged by comparing each window's raw offset to a
    # small median-filtered neighbourhood. This must happen before grouping,
    # not just influence its decisions: merely *smoothing the grouping
    # decision* (an earlier version of this fix) let a real outlier get
    # folded into a neighbouring group -- its own smoothed neighbourhood
    # looked normal enough to pass -- while its raw, wrong value still went
    # into that group's line fit, producing a nonsensical steep "drift"
    # from just 2 points, one of them garbage. Dropping it outright, like an
    # `ambiguous` window, avoids that regardless of which group would have
    # absorbed it.
    if len(offsets) >= _OUTLIER_FILTER_SIZE:
        smoothed = median_filter(offsets, size=_OUTLIER_FILTER_SIZE, mode="nearest")
        reliable = np.abs(offsets - smoothed) <= jump_threshold_s
        if 2 <= int(reliable.sum()) < len(offsets):
            usable = [w for w, keep in zip(usable, reliable) if keep]
            times = times[reliable]
            offsets = offsets[reliable]

    if len(usable) >= 2:
        # Fit-quality check (does one line explain every window at all)
        # uses the raw, unregularized fit -- a real, well-supported slope
        # must still pass this. Only the *reported* endpoints, below, use
        # the significance-gated version, so a technically-fits-but-noisy
        # slope doesn't get extrapolated into a start/end swing that was
        # never actually there (see _fit_line_or_constant).
        raw_slope, raw_intercept = np.polyfit(times, offsets, 1)
        residuals = offsets - (raw_intercept + raw_slope * times)
        if np.max(np.abs(residuals)) <= residual_tol_s:
            slope, intercept = _fit_line_or_constant(times, offsets)
            offset_start = float(intercept)
            offset_end = float(intercept + slope * total_duration_s)
            return [
                Segment(
                    start_s=0.0,
                    end_s=total_duration_s,
                    offset_start=offset_start,
                    offset_end=offset_end,
                    confidence=_segment_confidence(usable, 0.0, total_duration_s, offset_start, offset_end),
                )
            ]

    groups: list[list[WindowOffset]] = [[usable[0]]]
    for w in usable[1:]:
        current = groups[-1]
        median = float(np.median([x.offset_seconds for x in current]))
        if abs(w.offset_seconds - median) > jump_threshold_s:
            groups.append([w])
        else:
            current.append(w)

    # A new group is started by whichever window first deviates past the
    # threshold -- if that one window is itself a straggler (one the
    # outlier filter above narrowly let through), every following window
    # still joins *its* group, and two groups end up describing the exact
    # same offset. Real reported case: a -1.84s window (0.01s inside the
    # outlier filter's tolerance) seeded a tail group whose median was
    # -0.969s, identical to the preceding group's -0.969s, and its line fit,
    # pulled by that seed, came out as a fake -1.26s -> -0.81s drift.
    # Neighbouring groups whose medians don't actually differ by a jump are
    # one segment.
    merged = [groups[0]]
    for group in groups[1:]:
        prev_median = float(np.median([x.offset_seconds for x in merged[-1]]))
        median = float(np.median([x.offset_seconds for x in group]))
        if abs(median - prev_median) <= jump_threshold_s:
            merged[-1] = merged[-1] + group
        else:
            merged.append(group)
    groups = merged

    segments: list[Segment] = []
    for idx, group in enumerate(groups):
        seg_start = 0.0 if idx == 0 else (groups[idx - 1][-1].time_s + group[0].time_s) / 2.0
        seg_end = (
            total_duration_s
            if idx == len(groups) - 1
            else (group[-1].time_s + groups[idx + 1][0].time_s) / 2.0
        )
        if len(group) >= 2:
            g_times = np.array([g.time_s for g in group])
            g_offsets = np.array([g.offset_seconds for g in group])
            g_slope, g_intercept = _fit_line_or_constant(g_times, g_offsets)
            offset_start = float(g_intercept + g_slope * seg_start)
            offset_end = float(g_intercept + g_slope * seg_end)
        else:
            offset_start = offset_end = group[0].offset_seconds
        confidence = _segment_confidence(group, seg_start, seg_end, offset_start, offset_end)
        segments.append(Segment(seg_start, seg_end, offset_start, offset_end, confidence=confidence))
    return segments


# Boundary localization (see refine_boundary): each frame's agreement is
# measured on envelopes standardized over this sliding span, so a loud and a
# quiet passage weigh alike.
_LOCAL_NORM_S = 4.0
# How far (in noise standard deviations, scaled by sqrt(distance)) a split
# point's score may trail the best one and still count as equally plausible
# -- the set inside which audio energy picks the cut (see refine_boundary).
# Where the content says nothing, the score between two split points is a
# random walk, whose excursions this has to cover.
_BOUNDARY_TOLERANCE_SIGMAS = 3.0
# A stretch of candidate audio counts as a blank (see refine_boundary) when
# its RMS is below this fraction of the surrounding audio's mean RMS.
_BLANK_RMS_RATIO = 0.05

# (role, start_s, duration_s) -> per-frame RMS of that span, role being
# "ref" or "cand", at the envelope frame rate, starting at start_s.
EnergyReader = Callable[[str, float, float], np.ndarray]


def _moving_mean(x: np.ndarray, width: int) -> np.ndarray:
    width = max(1, min(width, len(x)))
    c = np.concatenate(([0.0], np.cumsum(x, dtype=np.float64)))
    lo = np.clip(np.arange(len(x)) - width // 2, 0, len(x) - width)
    return (c[lo + width] - c[lo]) / width


def _local_standardize(x: np.ndarray, width: int) -> np.ndarray:
    mean = _moving_mean(x, width)
    var = np.maximum(_moving_mean(x * x, width) - mean * mean, 0.0)
    return (x - mean) / np.sqrt(var + 1e-12)


def _sample_shifted(env: np.ndarray, frames: np.ndarray, offset_frames: float) -> np.ndarray:
    """``env`` read at ``frames + offset_frames`` (linear interpolation, 0 outside)."""
    return np.interp(frames + offset_frames, np.arange(len(env)), env, left=0.0, right=0.0)


def _interval_means(cumsum: np.ndarray, starts: np.ndarray, length: int) -> np.ndarray:
    starts = np.clip(starts, 0, len(cumsum) - 1)
    ends = np.clip(starts + max(1, length), 0, len(cumsum) - 1)
    return (cumsum[ends] - cumsum[starts]) / np.maximum(ends - starts, 1)


def refine_boundary(
    ref_env: np.ndarray,
    cand_env: np.ndarray,
    frame_rate: float,
    approx_time_s: float,
    offset_before: float,
    offset_after: float,
    *,
    zoom_s: float = _REFINE_ZOOM_S,
    min_time_s: float = 0.0,
    max_time_s: float | None = None,
    energy: EnergyReader | None = None,
) -> float:
    """Pinpoint a jump to the envelope frame (~16ms), near ``approx_time_s``.

    Every frame of the zone is scored against both alignments -- how well
    the reference matches the candidate read ``offset_before`` vs.
    ``offset_after`` later -- and the split point maximizing "before-offset
    agreement up to it + after-offset agreement from it on" wins. When the
    candidate is missing content (``offset_after < offset_before``), the
    frames right after the split are the gap to be filled with silence, so
    they count for neither side: the optimum is then exactly where the
    missing content starts.

    Where the reference has nothing distinctive (dialogue, quiet passage),
    that score goes flat and many split points are equally plausible. For
    extra candidate content, the audio then decides when ``energy`` is
    given: if one of those split points removes a genuine blank (see
    ``_BLANK_RMS_RATIO``), that is where the dub was padded, and it is found
    exactly. Only a real blank is trusted -- extra content that isn't one
    says nothing about where it sits, and neither does the loudness of
    content the candidate is missing.
    """
    fr = frame_rate
    lo_s = max(min_time_s, approx_time_s - zoom_s)
    hi_s = approx_time_s + zoom_s
    if max_time_s is not None:
        hi_s = min(hi_s, max_time_s)
    lo, hi = int(round(lo_s * fr)), min(len(ref_env), int(round(hi_s * fr)))
    if hi - lo < 4:
        return approx_time_s

    pad = int(_LOCAL_NORM_S * fr)
    ctx_lo, ctx_hi = max(0, lo - pad), min(len(ref_env), hi + pad)
    frames = np.arange(ctx_lo, ctx_hi, dtype=np.float64)
    width = int(_LOCAL_NORM_S * fr)
    zr = _local_standardize(ref_env[ctx_lo:ctx_hi], width)
    agree_before = (zr * _local_standardize(_sample_shifted(cand_env, frames, offset_before * fr), width))[
        lo - ctx_lo : hi - ctx_lo
    ]
    agree_after = (zr * _local_standardize(_sample_shifted(cand_env, frames, offset_after * fr), width))[
        lo - ctx_lo : hi - ctx_lo
    ]

    n = hi - lo
    gap = int(round(max(0.0, offset_before - offset_after) * fr))
    cum_before = np.concatenate(([0.0], np.cumsum(agree_before)))
    cum_after = np.concatenate(([0.0], np.cumsum(agree_after)))
    k = np.arange(n + 1)
    score = cum_before[k] + cum_after[n] - cum_after[np.minimum(n, k + gap)]
    best = int(np.argmax(score))

    sigma = float(np.std(agree_before - agree_after))
    plausible = score[best] - score <= _BOUNDARY_TOLERANCE_SIGMAS * sigma * np.sqrt(np.abs(k - best))
    candidates = np.flatnonzero(plausible)
    first, last = int(candidates[0]), int(candidates[-1])

    if energy is not None and len(candidates) > 1 and offset_after > offset_before:
        span = offset_after - offset_before
        span_frames = max(1, int(round(span * fr)))
        read_start = (lo + first) / fr + offset_before
        rms = energy("cand", read_start - span, (last - first) / fr + 3 * span)
        # rms[i] is the frame at read_start - span + i/fr; the chunk a split
        # at candidate c removes starts at frame (c - first) + span_frames.
        if len(rms) >= span_frames:
            cum = np.concatenate(([0.0], np.cumsum(rms)))
            cost = _interval_means(cum, candidates - first + span_frames, span_frames)
            surroundings = float(np.mean(rms))
            quietest = int(np.argmin(cost + 1e-9 * np.abs(candidates - best)))
            if surroundings > 0 and cost[quietest] < _BLANK_RMS_RATIO * surroundings:
                best = int(candidates[quietest])

    return (lo + best) / fr


def refine_segments(
    ref_env: np.ndarray,
    cand_env: np.ndarray,
    frame_rate: float,
    segments: Sequence[Segment],
    energy: EnergyReader | None = None,
) -> list[Segment]:
    """Refine every internal boundary of ``segments`` with ``refine_boundary``."""
    if len(segments) < 2:
        return list(segments)

    refined = [segments[0]]
    for cur in segments[1:]:
        prev = refined[-1]
        boundary = refine_boundary(
            ref_env, cand_env, frame_rate,
            approx_time_s=prev.end_s,
            offset_before=prev.offset_end,
            offset_after=cur.offset_start,
            min_time_s=prev.start_s,
            max_time_s=cur.end_s,
            energy=energy,
        )
        refined[-1] = dataclasses.replace(prev, end_s=boundary)
        refined.append(dataclasses.replace(cur, start_s=boundary))
    return refined


def energy_reader(
    reference: AudioTrackSpec, candidate: AudioTrackSpec, frame_rate: float, analysis_start_s: float = 0.0
) -> EnergyReader:
    """An ``EnergyReader`` decoding just the requested spans of both tracks."""
    hop = int(round(ANALYSIS_SAMPLE_RATE / frame_rate))

    def read(role: str, start_s: float, duration_s: float) -> np.ndarray:
        spec = reference if role == "ref" else candidate
        n_frames = max(0, int(np.ceil(duration_s * frame_rate)))
        lead = max(0, int(round(-start_s * frame_rate)))  # before the track: silence
        begin = analysis_start_s + max(0.0, start_s)
        pcm = extract_pcm(spec, ANALYSIS_SAMPLE_RATE, start=begin or None, duration=max(0.0, duration_s) + 1.0)
        usable = len(pcm) // hop
        rms = np.sqrt(np.mean(pcm[: usable * hop].reshape(usable, hop).astype(np.float64) ** 2, axis=1))
        out = np.zeros(n_frames)
        count = max(0, min(n_frames - lead, len(rms)))
        out[lead : lead + count] = rms[:count]
        return out

    return read


def detect_segments(
    reference: AudioTrackSpec,
    candidate: AudioTrackSpec,
    *,
    start: float = 0.0,
    duration: float | None = None,
    window_s: float = DEFAULT_WINDOW_S,
    hop_s: float = DEFAULT_HOP_S,
    margin_s: float = DEFAULT_MARGIN_S,
    log: Callable[[str], None] = lambda msg: None,
) -> list[Segment]:
    """End-to-end: extract both tracks, detect windowed offsets, classify, refine.

    The one-stop entry point used by both the `segments` CLI command and
    `render --segmented`.
    """
    ref_env, frame_rate = get_envelope(reference, ANALYSIS_SAMPLE_RATE, start, duration, log=log)
    cand_env, _ = get_envelope(candidate, ANALYSIS_SAMPLE_RATE, start, duration, log=log)

    # A close-enough stand-in for the reference's exact decoded sample count
    # (which the cache doesn't expose): STFT framing is off by at most one
    # window's worth of samples, irrelevant next to window_s/hop_s scale.
    total_duration_s = len(ref_env) / frame_rate

    log("[analyse] fenêtres glissantes...")
    windows = windowed_offsets(ref_env, cand_env, frame_rate, window_s=window_s, hop_s=hop_s, margin_s=margin_s)
    segs = classify_segments(windows, total_duration_s)
    if len(segs) > 1:
        log("[analyse] affinage des frontières...")
        segs = refine_segments(
            ref_env, cand_env, frame_rate, segs, energy=energy_reader(reference, candidate, frame_rate, start)
        )
    return segs
