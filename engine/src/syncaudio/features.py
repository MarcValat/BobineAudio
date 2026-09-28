from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np
from scipy.signal import stft

DEFAULT_N_FFT = 1024
DEFAULT_HOP = 256
# Part of the on-disk analysis cache key (see analysis_cache): bump it
# whenever a change alters envelope values, so no stale entry is reused.
ENVELOPE_VERSION = 1

_HARM_WIN = 17
_PERC_WIN = 17
_EPS = 1e-10

# The envelope is computed block by block over time (STFT, harmonic/percussive
# separation and flux fused per block) instead of one whole-track array per
# stage: a 2h track's spectrogram alone is ~1GB of float32, and the old
# pipeline held 4-5 of them at once. Blocks run in parallel (numpy ufuncs and
# scipy's FFT release the GIL); inside one, the median filters work on
# sub-blocks small enough to stay in CPU cache.
_BLOCK_FRAMES = 512
_MEDIAN_SUBBLOCK_FRAMES = 64
# Measured: past ~4 threads, contention costs more than the extra cores bring.
_WORKERS = min(4, os.cpu_count() or 1)
_pool = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="syncaudio-envelope")


@lru_cache(maxsize=None)
def _median_network(size: int) -> tuple[tuple[str, int, int, bool, bool], ...]:
    """Min/max ops selecting the element of rank ``size // 2`` out of ``size`` lanes.

    That rank is exactly what ``scipy.ndimage.median_filter`` returns (the
    upper middle one for an even ``size``), and min/max only ever move
    values around, so the result is bit-identical to it. Built from Batcher's
    odd-even merge sort, padded to a power of two with +inf lanes (their
    comparators become plain lane swaps or no-ops), then pruned to the ops
    the middle output actually depends on, each keeping only the min and/or
    max it needs.
    """
    p = 1
    while p < size:
        p *= 2
    pairs = []
    t = 1
    while t < p:
        k = t
        while k >= 1:
            j = k % t
            while j < p - k:
                for i in range(min(k, p - j - k)):
                    if (i + j) // (t * 2) == (i + j + k) // (t * 2):
                        pairs.append((i + j, i + j + k))
                j += 2 * k
            k //= 2
        t *= 2

    infinite = set(range(size, p))
    ops = []
    for a, b in pairs:
        if b in infinite:
            continue
        if a in infinite:
            infinite.discard(a)
            infinite.add(b)
            ops.append(("swap", a, b))
        else:
            ops.append(("cmp", a, b))

    needed = {size // 2}
    pruned = []
    for kind, a, b in reversed(ops):
        if a not in needed and b not in needed:
            continue
        if kind == "swap":
            pruned.append((kind, a, b, True, True))
            needed = {b if x == a else a if x == b else x for x in needed}
        else:
            pruned.append((kind, a, b, a in needed, b in needed))
            needed |= {a, b}
    return tuple(reversed(pruned))


def _median_valid(padded: np.ndarray, size: int, axis: int) -> np.ndarray:
    """Running median of ``size`` along ``axis``, "valid" part only (no padding)."""
    n = padded.shape[axis] - size + 1
    if axis == 0:
        lanes: list[np.ndarray | None] = [padded[k : k + n].copy() for k in range(size)]
    else:
        lanes = [padded[:, k : k + n].copy() for k in range(size)]
    tmp = np.empty_like(lanes[0])
    for kind, a, b, keep_min, keep_max in _median_network(size):
        if kind == "swap":
            lanes[a], lanes[b] = lanes[b], lanes[a]
        elif keep_min and keep_max:
            np.minimum(lanes[a], lanes[b], out=tmp)
            np.maximum(lanes[a], lanes[b], out=lanes[b])
            lanes[a], tmp = tmp, lanes[a]
        elif keep_min:
            np.minimum(lanes[a], lanes[b], out=lanes[a])
        else:
            np.maximum(lanes[a], lanes[b], out=lanes[b])
    return lanes[size // 2]


def _median_filter(mag: np.ndarray, size: int, axis: int, pad: tuple[int, int] | None = None) -> np.ndarray:
    """``scipy.ndimage.median_filter`` along one axis of a 2D array, bit-identical.

    ``pad`` is how much of the filter's reach along ``axis`` is missing from
    ``mag`` at each end (default: all of it, i.e. ``mag`` is the whole
    signal). The missing part is filled by mirroring, as scipy's default
    ``mode="reflect"`` does (numpy calls that mode "symmetric").
    """
    if pad is None:
        pad = (size // 2, size - 1 - size // 2)
    widths = [(0, 0), (0, 0)]
    widths[axis] = pad
    padded = np.pad(mag, widths, mode="symmetric") if any(pad) else mag
    reach = size - 1 if axis == 1 else 0
    out_frames = padded.shape[1] - reach
    out = np.empty((padded.shape[0] - (size - 1 - reach), out_frames), dtype=mag.dtype)
    for a in range(0, out_frames, _MEDIAN_SUBBLOCK_FRAMES):
        b = min(out_frames, a + _MEDIAN_SUBBLOCK_FRAMES)
        out[:, a:b] = _median_valid(padded[:, a : b + reach], size, axis)
    return out


def _stft_magnitude(signal: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    _, _, zxx = stft(signal, window="hann", nperseg=n_fft, noverlap=n_fft - hop)
    return np.abs(zxx)


def _frame_count(n_samples: int, n_fft: int, hop: int) -> int:
    """How many frames ``_stft_magnitude`` yields (scipy's boundary + padding rules)."""
    padded_len = n_samples + 2 * (n_fft // 2)
    padded_len += (-(padded_len - n_fft) % hop) % n_fft
    return (padded_len - n_fft) // hop + 1


def _stft_magnitude_frames(signal: np.ndarray, n_fft: int, hop: int, lo: int, hi: int) -> np.ndarray:
    """Frames ``[lo, hi)`` of ``_stft_magnitude(signal)``, bit-identical, without the rest.

    Rebuilds exactly the samples those frames see in scipy's zero-extended
    signal. ``padded=True`` is kept on purpose even though the slice already
    needs no end padding: that code path is where scipy upcasts to float64
    before the FFT, so skipping it would change the rounding.
    """
    start = lo * hop - n_fft // 2
    end = (hi - 1) * hop + n_fft - n_fft // 2
    chunk = np.zeros(end - start, dtype=signal.dtype)
    s, e = max(start, 0), min(end, len(signal))
    if e > s:
        chunk[s - start : e - start] = signal[s:e]
    _, _, zxx = stft(chunk, window="hann", nperseg=n_fft, noverlap=n_fft - hop, boundary=None, padded=True)
    return np.abs(zxx)


def _envelope_block(signal: np.ndarray, n_fft: int, hop: int, n_frames: int, a: int, b: int) -> np.ndarray:
    """Onset envelope values for frames ``[a, b)`` (see ``_percussive_component``/``_onset_envelope``)."""
    s = max(a - 1, 0)  # the flux of frame a needs frame a-1
    reach_lo, reach_hi = _HARM_WIN // 2, _HARM_WIN - 1 - _HARM_WIN // 2
    lo, hi = max(0, s - reach_lo), min(n_frames, b + reach_hi)
    mag = _stft_magnitude_frames(signal, n_fft, hop, lo, hi)

    harmonic = _median_filter(mag, _HARM_WIN, axis=1, pad=(lo - (s - reach_lo), (b + reach_hi) - hi))
    mag = mag[:, s - lo : b - lo]
    percussive = _median_filter(mag, _PERC_WIN, axis=0)
    mask = percussive / (percussive + harmonic + _EPS)
    log_mag = np.log1p(mag * mask)
    flux = np.maximum(np.diff(log_mag, axis=1), 0.0).sum(axis=0)
    return np.concatenate((np.zeros(1, dtype=flux.dtype), flux)) if a == 0 else flux


def _percussive_component(mag: np.ndarray, harm_win: int = _HARM_WIN, perc_win: int = _PERC_WIN) -> np.ndarray:
    """Isolate the percussive (transient) part of a spectrogram via median filtering.

    Music/SFX transients (hits, impacts) are sparse across time but spread
    across frequency, while harmonic content (sustained tones, vowels in
    speech) is smooth across time but narrow in frequency — median-filtering
    each way and soft-masking separates them (Fitzgerald, 2010).
    """
    harmonic = _median_filter(mag, harm_win, axis=1)
    percussive = _median_filter(mag, perc_win, axis=0)
    mask = percussive / (percussive + harmonic + _EPS)
    return mag * mask


def _onset_envelope(percussive_mag: np.ndarray) -> np.ndarray:
    """Half-wave rectified spectral flux: a 1D onset-strength signal per frame."""
    log_mag = np.log1p(percussive_mag)
    flux = np.diff(log_mag, axis=1)
    flux = np.maximum(flux, 0.0)
    env = flux.sum(axis=0)
    return np.concatenate(([0.0], env))


def extract_envelope(
    pcm: np.ndarray,
    sample_rate: int,
    n_fft: int = DEFAULT_N_FFT,
    hop: int = DEFAULT_HOP,
) -> tuple[np.ndarray, float]:
    """Compute a language-robust onset envelope for a mono PCM signal.

    Returns ``(envelope, frame_rate)`` where ``frame_rate`` is the number of
    envelope frames per second (so downstream lags convert cleanly to
    seconds). Bit-identical to ``_onset_envelope(_percussive_component(
    _stft_magnitude(pcm)))``, just computed block by block.
    """
    frame_rate = sample_rate / hop
    if len(pcm) < n_fft:
        return _onset_envelope(_percussive_component(_stft_magnitude(pcm, n_fft, hop))), frame_rate
    n_frames = _frame_count(len(pcm), n_fft, hop)
    starts = list(range(0, n_frames, _BLOCK_FRAMES))
    # A last block of one frame would sum its flux as a (bins, 1) array,
    # which numpy reduces pairwise instead of row by row: different rounding.
    if len(starts) > 1 and n_frames - starts[-1] < 2:
        starts.pop()
    ends = starts[1:] + [n_frames]
    parts = _pool.map(lambda ab: _envelope_block(pcm, n_fft, hop, n_frames, *ab), zip(starts, ends))
    return np.concatenate(list(parts)).astype(np.float64), frame_rate
