from __future__ import annotations

import dataclasses
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import median_filter

from syncaudio.align import estimate_offset
from syncaudio.analysis_cache import ANALYSIS_SAMPLE_RATE, get_envelope
from syncaudio.models import AudioTrackSpec

DEFAULT_WINDOW_S = 30.0
DEFAULT_HOP_S = 10.0
DEFAULT_MARGIN_S = 8.0

# Boundary refinement pass (see refine_segments): a small window/hop, applied
# only in a zoomed-in neighbourhood of each coarse boundary, localizes a jump
# far more precisely than the coarse pass alone -- a coarse window straddles
# up to a whole DEFAULT_WINDOW_S of mixed before/after content near the true
# jump, which is what limits the coarse pass's boundary precision.
_REFINE_ZOOM_S = 45.0
_REFINE_WINDOW_S = 8.0
_REFINE_HOP_S = 2.0

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


def refine_boundary(
    ref_env: np.ndarray,
    cand_env: np.ndarray,
    frame_rate: float,
    approx_time_s: float,
    offset_before: float,
    offset_after: float,
    *,
    zoom_s: float = _REFINE_ZOOM_S,
    window_s: float = _REFINE_WINDOW_S,
    hop_s: float = _REFINE_HOP_S,
) -> float:
    """Pinpoint a jump more precisely than the coarse windowed pass did.

    Re-runs the windowed search with a much smaller window/hop, but only in
    a zone around ``approx_time_s``: cheap, because it only touches a small
    neighbourhood, and more precise there, because a small window straddles
    far less of the actual transition than the coarse ``DEFAULT_WINDOW_S``
    one did (that straddling -- mixed before/after content in one window --
    is what limits the coarse pass's boundary precision to roughly its
    window size).

    Individual fine windows can still be noisy right at the transition
    (mixed content briefly confuses the correlation), so rather than trust
    the first window that crosses to the other side -- fragile, a single
    stray reading can fake a crossing -- this picks the split point that
    minimizes the *total* variance on each side across every fine window in
    the zone, a fit anchored on the whole picture rather than one sample.
    """
    margin_s = abs(offset_after - offset_before) / 2.0 + 3.0
    start = max(0.0, approx_time_s - zoom_s)
    end = approx_time_s + zoom_s
    fine = windowed_offsets(
        ref_env,
        cand_env,
        frame_rate,
        window_s=window_s,
        hop_s=hop_s,
        margin_s=margin_s,
        search_start_s=start,
        search_end_s=end,
    )
    usable = [w for w in fine if not w.ambiguous]
    if len(usable) < 4:
        return approx_time_s

    times = np.array([w.time_s for w in usable])
    offsets = np.array([w.offset_seconds for w in usable])

    best_cost = None
    best_m = None
    for m in range(2, len(usable) - 1):
        left, right = offsets[:m], offsets[m:]
        cost = float(np.sum((left - left.mean()) ** 2) + np.sum((right - right.mean()) ** 2))
        if best_cost is None or cost < best_cost:
            best_cost, best_m = cost, m
    if best_m is None:
        return approx_time_s

    boundary = (times[best_m - 1] + times[best_m]) / 2.0
    return float(np.clip(boundary, start, end))


def refine_segments(
    ref_env: np.ndarray,
    cand_env: np.ndarray,
    frame_rate: float,
    segments: Sequence[Segment],
) -> list[Segment]:
    """Refine every internal boundary of ``segments`` with ``refine_boundary``."""
    if len(segments) < 2:
        return list(segments)

    refined = [segments[0]]
    for cur in segments[1:]:
        prev = refined[-1]
        original_boundary = prev.end_s
        boundary = refine_boundary(
            ref_env, cand_env, frame_rate,
            approx_time_s=original_boundary,
            offset_before=prev.offset_end,
            offset_after=cur.offset_start,
        )
        # Refinement only searches a local zoom window, but a noisy/spurious
        # coarse segment (e.g. a one-window outlier) can still send the fine
        # crossing search off to a nonsensical point -- never let a boundary
        # cross into a neighbouring segment's own span, and fall back to the
        # coarse estimate rather than emit an invalid (non-monotonic) range.
        if not (prev.start_s < boundary < cur.end_s):
            boundary = original_boundary
        refined[-1] = dataclasses.replace(prev, end_s=boundary)
        refined.append(dataclasses.replace(cur, start_s=boundary))
    return refined


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
        segs = refine_segments(ref_env, cand_env, frame_rate, segs)
    return segs
