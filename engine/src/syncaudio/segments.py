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
# Outlier tolerance (see classify_segments): at least this, or this many
# window-to-window noise standard deviations where windows are noisier.
_OUTLIER_MIN_TOL_S = 0.1
_OUTLIER_NOISE_SIGMAS = 4.0
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
    # The window's length: its estimate describes its middle, not its start
    # -- under drift, the offset at the start is already a window's worth of
    # slope away (0.15s for 1% over 30s).
    duration_s: float = 0.0
    # Drift (s/s) already known and compensated for when measuring this
    # window (see destretched_windows): level changes are looked for on top
    # of it, not in the ramp itself.
    drift_rate: float = 0.0

    @property
    def center_s(self) -> float:
        return self.time_s + self.duration_s / 2.0


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
                    duration_s=window_s,
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

    times = np.array([w.center_s for w in group])
    offsets = np.array([w.offset_seconds for w in group])
    span = end_s - start_s
    slope = (offset_end - offset_start) / span if span > 0 else 0.0
    residuals = offsets - (offset_start + slope * (times - start_s))
    robust_sigma = 1.4826 * float(np.median(np.abs(residuals - np.median(residuals))))
    precision = max(0.0, 1.0 - (robust_sigma / n**0.5) / _PRECISION_SCALE_S)
    return float(sample_factor * precision)


# Small jumps (see _split_small_jumps): a level change counts from this size
# up, when it also stands out from the windows' own scatter by this many
# standard errors, with at least this many windows on each side.
_SMALL_JUMP_MIN_S = 0.02
_SMALL_JUMP_MIN_TSTAT = 5.0
_SMALL_JUMP_MIN_WINDOWS = 3
# Both judged on the windows right around the split (this many on each
# side; the far parts of either side may hold further jumps of their own),
# and the jump must also exceed their scatter by this factor: the standard
# error alone can call two interleaved values (MAD collapses on them) a
# staircase of highly significant jumps.
_SMALL_JUMP_SCATTER_WINDOWS = 5
_SMALL_JUMP_MIN_SCATTER_RATIO = 3.0
# Floor for scatter estimates: envelope frames are 16ms, sub-frame
# refinement doesn't make estimates much steadier than this.
_NOISE_FLOOR_S = 0.001


def _robust_scale(x: np.ndarray) -> float:
    return 1.4826 * float(np.median(np.abs(x - np.median(x)))) if len(x) else 0.0


def _split_small_jumps(group: list[WindowOffset]) -> list[list[WindowOffset]]:
    """Recursively split a group at level changes below the big-jump threshold.

    A real dub is often off by a few tens of ms from one scene to the next
    (measured on the fixtures' source: +47ms, then -36ms, then -115ms), well
    under ``_JUMP_THRESHOLD_S``. Such a level change is split off when it is
    at least ``_SMALL_JUMP_MIN_S``, clearly beyond the windows' own scatter
    and carried by ``_SMALL_JUMP_MIN_WINDOWS`` windows on each side (so a
    straggler or two never qualifies). A group that one straight line
    already explains to within its window-to-window noise is left whole:
    that's drift (or a constant), not a staircase.
    """
    n = len(group)
    if n < 2 * _SMALL_JUMP_MIN_WINDOWS:
        return [group]
    times = np.array([w.center_s for w in group])
    offsets = np.array([w.offset_seconds - w.drift_rate * w.center_s for w in group])

    step_noise = max(_NOISE_FLOOR_S, _robust_scale(np.diff(offsets)) / np.sqrt(2.0))
    slope = _theil_sen_slope(times, offsets)
    line_residuals = offsets - (np.median(offsets - slope * times) + slope * times)
    if _robust_scale(line_residuals) <= 2.0 * step_noise:
        return [group]

    # Where to split: the point that best explains the group as two levels
    # (largest drop in total absolute deviation from the median) -- robust
    # to further jumps elsewhere in the group, which a significance test
    # over each whole side is not.
    def l1(x: np.ndarray) -> float:
        return float(np.sum(np.abs(x - np.median(x))))

    total = l1(offsets)
    splits = range(_SMALL_JUMP_MIN_WINDOWS, n - _SMALL_JUMP_MIN_WINDOWS + 1)
    best_m = max(splits, key=lambda m: total - l1(offsets[:m]) - l1(offsets[m:]))

    # Whether it's real: judged on the windows right around it only.
    near_left = offsets[max(0, best_m - _SMALL_JUMP_SCATTER_WINDOWS) : best_m]
    near_right = offsets[best_m : best_m + _SMALL_JUMP_SCATTER_WINDOWS]
    ml, mr = float(np.median(near_left)), float(np.median(near_right))
    deviations = np.concatenate([near_left - ml, near_right - mr])
    scale = max(_NOISE_FLOOR_S, _robust_scale(deviations))
    t = abs(mr - ml) / (scale * np.sqrt(1.0 / len(near_left) + 1.0 / len(near_right)))
    scatter = 1.2533 * float(np.mean(np.abs(deviations)))
    if t < _SMALL_JUMP_MIN_TSTAT or abs(mr - ml) < max(_SMALL_JUMP_MIN_S, _SMALL_JUMP_MIN_SCATTER_RATIO * scatter):
        return [group]
    return _split_small_jumps(group[:best_m]) + _split_small_jumps(group[best_m:])


def _group_big_jumps(usable: list[WindowOffset], jump_threshold_s: float) -> list[list[WindowOffset]]:
    """Split wherever the offset jumps by more than ``jump_threshold_s`` and stays there."""
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
    return merged


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
    explains the data within ``residual_tol_s``, there is no big jump.
    Otherwise, splits into groups wherever the offset jumps by more than
    ``jump_threshold_s`` and stays there. Each group is then split further
    at smaller, sustained level changes (see ``_split_small_jumps``), and a
    line is fitted within each resulting segment (flat = constant offset,
    sloped = drift).
    """
    usable = [w for w in windows if not w.ambiguous]
    if len(usable) < 2:
        usable = list(windows)
    if not usable:
        return [Segment(0.0, total_duration_s, 0.0, 0.0, confidence=0.0)]

    times = np.array([w.center_s for w in usable])
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
        # Tight enough to catch a 0.2s blip next to a small jump (it would
        # drown that jump in scatter, see _split_small_jumps), loosened where
        # windows are naturally noisy (drift smears the correlation peak).
        # A real jump's edge windows follow their neighbourhood median, so
        # they are never flagged, however small the tolerance.
        step_noise = max(_NOISE_FLOOR_S, _robust_scale(np.diff(offsets)) / np.sqrt(2.0))
        tolerance = min(jump_threshold_s, max(_OUTLIER_MIN_TOL_S, _OUTLIER_NOISE_SIGMAS * step_noise))
        reliable = np.abs(offsets - smoothed) <= tolerance
        if 2 <= int(reliable.sum()) < len(offsets):
            usable = [w for w, keep in zip(usable, reliable) if keep]
            times = times[reliable]
            offsets = offsets[reliable]

    single_line = False
    if len(usable) >= 2:
        # Fit-quality check (does one line explain every window at all)
        # uses the raw, unregularized fit -- a real, well-supported slope
        # must still pass this. Only the *reported* endpoints, below, use
        # the significance-gated version, so a technically-fits-but-noisy
        # slope doesn't get extrapolated into a start/end swing that was
        # never actually there (see _fit_line_or_constant).
        raw_slope, raw_intercept = np.polyfit(times, offsets, 1)
        residuals = offsets - (raw_intercept + raw_slope * times)
        single_line = bool(np.max(np.abs(residuals)) <= residual_tol_s)

    groups = [list(usable)] if single_line else _group_big_jumps(usable, jump_threshold_s)
    groups = [part for group in groups for part in _split_small_jumps(group)]

    segments: list[Segment] = []
    for idx, group in enumerate(groups):
        seg_start = 0.0 if idx == 0 else (groups[idx - 1][-1].center_s + group[0].center_s) / 2.0
        seg_end = (
            total_duration_s
            if idx == len(groups) - 1
            else (group[-1].center_s + groups[idx + 1][0].center_s) / 2.0
        )
        if len(group) >= 2:
            g_times = np.array([g.center_s for g in group])
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


def _sample_shifted(env: np.ndarray, frames: np.ndarray, offset_frames: float | np.ndarray) -> np.ndarray:
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
    slope_before: float = 0.0,
    slope_after: float = 0.0,
) -> float:
    """Pinpoint a jump to the envelope frame (~16ms), near ``approx_time_s``.

    Every frame of the zone is scored against both alignments -- how well
    the reference matches the candidate read ``offset_before`` vs.
    ``offset_after`` later -- and the split point maximizing "before-offset
    agreement up to it + after-offset agreement from it on" wins. When the
    candidate is missing content (``offset_after < offset_before``), the
    frames right after the split are the gap to be filled with silence, so
    they count for neither side: the optimum is then exactly where the
    missing content starts. ``offset_before``/``offset_after`` are each
    side's offset at ``approx_time_s``; on a drifting side, its
    ``slope_*`` carries it across the zone.

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
    since = frames / fr - approx_time_s
    shift_before = (offset_before + slope_before * since) * fr
    shift_after = (offset_after + slope_after * since) * fr
    agree_before = (zr * _local_standardize(_sample_shifted(cand_env, frames, shift_before), width))[
        lo - ctx_lo : hi - ctx_lo
    ]
    agree_after = (zr * _local_standardize(_sample_shifted(cand_env, frames, shift_after), width))[
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

    def slope(seg: Segment) -> float:
        span = seg.end_s - seg.start_s
        return (seg.offset_end - seg.offset_start) / span if span > 0 else 0.0

    refined = [segments[0]]
    for cur in segments[1:]:
        prev = refined[-1]
        prev_slope, cur_slope = slope(prev), slope(cur)
        approx = prev.end_s
        boundary = refine_boundary(
            ref_env, cand_env, frame_rate,
            approx_time_s=approx,
            offset_before=prev.offset_end,
            offset_after=cur.offset_start,
            min_time_s=prev.start_s,
            max_time_s=cur.end_s,
            energy=energy,
            slope_before=prev_slope,
            slope_after=cur_slope,
        )
        # Each side keeps its own line through the moved boundary.
        refined[-1] = dataclasses.replace(
            prev, end_s=boundary, offset_end=prev.offset_end + prev_slope * (boundary - approx)
        )
        refined.append(
            dataclasses.replace(cur, start_s=boundary, offset_start=cur.offset_start + cur_slope * (boundary - approx))
        )
    return refined


# Segment offset re-estimation (see reestimate_offsets): how much of each
# end is left out (next to a boundary, content may still belong to the
# neighbour), and how far around the coarse estimate to search.
_REESTIMATE_EDGE_S = 1.0
_REESTIMATE_SEARCH_S = 0.5


def reestimate_offsets(
    ref_env: np.ndarray, cand_env: np.ndarray, frame_rate: float, segments: Sequence[Segment]
) -> list[Segment]:
    """Measure each constant segment's offset over the whole segment at once.

    The coarse offsets come from 30s windows, some straddling a jump (mixed
    content pulls them) and each seeing only a slice of the segment; once
    the boundaries are known, one correlation over everything between them
    is both unbiased and far more precise. Drift segments keep their fit.
    """
    out = []
    for seg in segments:
        lo_s, hi_s = seg.start_s + _REESTIMATE_EDGE_S, seg.end_s - _REESTIMATE_EDGE_S
        if seg.is_drift or hi_s - lo_s < 2 * _REESTIMATE_SEARCH_S:
            out.append(seg)
            continue
        approx = seg.mean_offset
        ref_lo, ref_hi = int(round(lo_s * frame_rate)), min(len(ref_env), int(round(hi_s * frame_rate)))
        cand_lo = int(round((lo_s + approx - _REESTIMATE_SEARCH_S) * frame_rate))
        cand_hi = int(round((hi_s + approx + _REESTIMATE_SEARCH_S) * frame_rate))
        if ref_hi - ref_lo < 2 or cand_lo < 0 or cand_hi > len(cand_env):
            out.append(seg)
            continue
        estimate = estimate_offset(ref_env[ref_lo:ref_hi], cand_env[cand_lo:cand_hi], frame_rate)
        offset = estimate.offset_seconds + (cand_lo - ref_lo) / frame_rate
        if abs(offset - approx) > _REESTIMATE_SEARCH_S:
            out.append(seg)  # the search edge, not a real peak
            continue
        out.append(dataclasses.replace(seg, offset_start=offset, offset_end=offset))
    return out


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


def compensate_drift(
    ref_env: np.ndarray, cand_env: np.ndarray, frame_rate: float, windows: Sequence[WindowOffset], **window_args
) -> list[WindowOffset]:
    """Re-measure every drifting stretch of ``windows`` with its drift undone.

    Only stretches free of big jumps are considered (the whole track if one
    line fits it, else each group between big jumps): a slope fitted across
    a jump would read the jump itself as drift.
    """
    usable = [w for w in windows if not w.ambiguous]
    if len(usable) < _CONFIDENT_WINDOW_COUNT:
        return list(windows)
    times = np.array([w.center_s for w in usable])
    offsets = np.array([w.offset_seconds for w in usable])
    raw_slope, raw_intercept = np.polyfit(times, offsets, 1)
    one_line = np.max(np.abs(offsets - (raw_intercept + raw_slope * times))) <= _RESIDUAL_TOL_S
    groups = [usable] if one_line else _group_big_jumps(usable, _JUMP_THRESHOLD_S)

    result = list(windows)
    for group in groups:
        if len(group) < _CONFIDENT_WINDOW_COUNT:
            continue
        g_times = np.array([w.center_s for w in group])
        slope, _ = _fit_line_or_constant(g_times, np.array([w.offset_seconds for w in group]))
        if abs(slope) * (g_times[-1] - g_times[0]) <= _DRIFT_EPS_S:
            continue
        first, last = group[0].time_s, group[-1].time_s

        def redo(rate: float) -> list[WindowOffset]:
            return [
                w
                for w in destretched_windows(ref_env, cand_env, frame_rate, rate, **window_args)
                if first <= w.time_s <= last
            ]

        redone = redo(slope)
        # The first slope comes from smeared, noisy windows; once they are
        # sharp, the drift left over is measured again and undone too.
        residual = _step_slope([w for w in redone if not w.ambiguous], slope)
        if residual:
            redone = redo(slope + residual)
        by_time = {w.time_s: w for w in redone}
        result = [by_time.get(w.time_s, w) if first <= w.time_s <= last else w for w in result]
    return result


def _step_slope(windows: Sequence[WindowOffset], compensated_rate: float) -> float:
    """Drift left over on top of ``compensated_rate``, from consecutive windows.

    The median of window-to-window slopes rather than a line through all of
    them: a small jump only skews the one difference it falls into, while
    a staircase of them (a dub a few tens of ms off from scene to scene)
    would tilt any overall fit -- that tilt is enough to hide a jump.
    """
    if len(windows) < _CONFIDENT_WINDOW_COUNT:
        return 0.0
    times = np.array([w.center_s for w in windows])
    residuals = np.array([w.offset_seconds for w in windows]) - compensated_rate * times
    return float(np.median(np.diff(residuals) / np.diff(times)))


def destretched_windows(
    ref_env: np.ndarray, cand_env: np.ndarray, frame_rate: float, slope: float, **window_args
) -> list[WindowOffset]:
    """``windowed_offsets`` measured on a candidate with ``slope`` of drift undone.

    Under drift, the candidate's content slides by ``slope * window_s``
    within each window (0.3s for 1% over 30s), smearing the correlation
    peak: estimates jump around by a good part of that. Reading the
    candidate at ``(1 + slope) * t`` first cancels the drift, the peak is
    sharp again, and each measured offset o' maps back exactly to the real
    one: the content at reference time t sits at candidate time
    (1 + slope) * (t + o'), i.e. an offset of slope * t + (1 + slope) * o'.
    """
    frames = np.arange(int(len(cand_env) / (1.0 + slope)), dtype=np.float64)
    destretched = np.interp(frames * (1.0 + slope), np.arange(len(cand_env)), cand_env)
    return [
        dataclasses.replace(
            w, offset_seconds=slope * w.center_s + (1.0 + slope) * w.offset_seconds, drift_rate=slope
        )
        for w in windowed_offsets(ref_env, destretched, frame_rate, **window_args)
    ]


def analyze_segments(
    reference: AudioTrackSpec,
    candidate: AudioTrackSpec,
    *,
    start: float = 0.0,
    duration: float | None = None,
    window_s: float = DEFAULT_WINDOW_S,
    hop_s: float = DEFAULT_HOP_S,
    margin_s: float = DEFAULT_MARGIN_S,
    log: Callable[[str], None] = lambda msg: None,
) -> tuple[list[WindowOffset], list[Segment], float]:
    """The whole detection pipeline: ``(windows, segments, total_duration_s)``.

    Windowed offsets (re-measured with any drift compensated), classified
    into segments, boundaries located to the frame, then each segment's
    offset measured over its whole span.
    """
    ref_env, frame_rate = get_envelope(reference, ANALYSIS_SAMPLE_RATE, start, duration, log=log)
    cand_env, _ = get_envelope(candidate, ANALYSIS_SAMPLE_RATE, start, duration, log=log)

    # A close-enough stand-in for the reference's exact decoded sample count
    # (which the cache doesn't expose): STFT framing is off by at most one
    # window's worth of samples, irrelevant next to window_s/hop_s scale.
    total_duration_s = len(ref_env) / frame_rate

    log("[analyse] fenêtres glissantes...")
    window_args = {"window_s": window_s, "hop_s": hop_s, "margin_s": margin_s}
    windows = compensate_drift(
        ref_env, cand_env, frame_rate, windowed_offsets(ref_env, cand_env, frame_rate, **window_args), **window_args
    )
    segs = classify_segments(windows, total_duration_s)
    if len(segs) > 1:
        log("[analyse] affinage des frontières...")
        segs = refine_segments(
            ref_env, cand_env, frame_rate, segs, energy=energy_reader(reference, candidate, frame_rate, start)
        )
    return windows, reestimate_offsets(ref_env, cand_env, frame_rate, segs), total_duration_s


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
    """``analyze_segments``' segments: the entry point for the GUI and `render --segmented`."""
    return analyze_segments(
        reference, candidate, start=start, duration=duration, window_s=window_s, hop_s=hop_s, margin_s=margin_s, log=log
    )[1]
