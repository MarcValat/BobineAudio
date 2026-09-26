"""In-memory cache for whole-track waveform peaks (see server.py's ``/waveform``).

Unlike ``analysis_cache.py`` (which caches the STFT/HPSS envelope -- the
actually CPU-heavy step for detection), a waveform request never runs that
analysis at all: it's a plain ffmpeg PCM decode downsampled into (min, max)
buckets, "well under a second" even for a multi-minute track (see
``extract_peaks``'s docstring). But the GUI re-fetches the *same* track's
waveform repeatedly across a session -- reopening "Modifier" in batch mode,
switching between analyzed tracks in single-file mode, previewing a manual
segment edit -- and each of those re-decodes the whole file from scratch for
no reason: the peaks for a given (file, track, start, duration, buckets)
never change on their own. In particular, editing a segment's offsets in the
GUI never touches this cache at all -- reference/candidate alignment is
applied entirely client-side by re-slicing the already-fetched peaks
(TrackPreview.tsx's offsetAt/resamplePeaks), so a cached entry here can never
go stale from that.

Each entry is tiny (``buckets`` floats x2, not the raw decoded audio -- a
whole-track fetch is 20000 buckets, ~160KB), so this can afford to keep far
more entries than analysis_cache's raw-PCM-sized ones.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np

from syncaudio.ffmpeg_backend import extract_peaks
from syncaudio.models import AudioTrackSpec

_MAX_ENTRIES = 256
_CacheKey = tuple[str, int, int, float, float | None]

_cache: OrderedDict[_CacheKey, tuple[np.ndarray, np.ndarray, float]] = OrderedDict()
_inflight: dict[_CacheKey, threading.Event] = {}
_lock = threading.Lock()


def _key(spec: AudioTrackSpec, buckets: int, start: float, duration: float | None) -> _CacheKey:
    idx = spec.stream_index if spec.stream_index is not None else 0
    return (str(Path(spec.path).resolve()), idx, buckets, start, duration)


def get_peaks(
    spec: AudioTrackSpec, buckets: int, start: float = 0.0, duration: float | None = None
) -> tuple[np.ndarray, np.ndarray, float]:
    """Return ``(mins, maxes, actual_duration)`` for ``spec``, computing it only on a cache miss.

    Same concurrent-request coalescing as ``analysis_cache.get_envelope``:
    only the first caller for a given key actually decodes, everyone else
    for that key blocks and reuses the result (e.g. the reference and
    candidate tracks of a pair are two different keys and decode in
    parallel just fine, but reopening the same track's preview a second
    time while the first fetch is still in flight won't trigger a second
    decode).
    """
    key = _key(spec, buckets, start, duration)

    while True:
        with _lock:
            cached = _cache.get(key)
            if cached is not None:
                _cache.move_to_end(key)
                return cached

            event = _inflight.get(key)
            if event is None:
                event = threading.Event()
                _inflight[key] = event
                is_owner = True
            else:
                is_owner = False

        if is_owner:
            break

        event.wait()
        # Loop back around: the owner either populated the cache (common
        # case, we'll hit it above) or failed (rare), in which case we
        # retry the whole thing and become the new owner ourselves.

    try:
        result = extract_peaks(spec, buckets, start=start, duration=duration)
        with _lock:
            _cache[key] = result
            _cache.move_to_end(key)
            while len(_cache) > _MAX_ENTRIES:
                _cache.popitem(last=False)
        return result
    finally:
        with _lock:
            _inflight.pop(key, None)
        event.set()


def clear() -> None:
    """Drop every cached entry (mainly for tests, to avoid cross-test leakage)."""
    with _lock:
        _cache.clear()
        _inflight.clear()
