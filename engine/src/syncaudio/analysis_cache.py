"""Cache for the expensive part of track analysis, in memory and on disk.

Measured on a real 6-minute track: ffmpeg extraction (decode to PCM) takes
~0.3-0.4s; the envelope computation (STFT + harmonic/percussive
median-filter separation, in ``features.py``) took ~7s single-threaded,
~0.8s since it runs in parallel cache-sized blocks -- still most of the
total. ``align``/``segments``/``render`` each ask for their reference (and
every candidate) envelope from scratch, even across separate calls on the
exact same track -- this cache lets a second request for the same (file,
track, analysis window) skip straight to the correlation math.

Entries are keyed on the file's identity (resolved path, size, mtime), so a
file replaced on disk is never answered from a stale analysis. They are
also persisted on disk (a few MB per hour of audio), so reopening a file
analyzed in an earlier session skips the analysis altogether.

Concurrent requests for the *same* key (e.g. a background prefetch and a
user-triggered detection racing each other) are coalesced: only the first
caller actually extracts/analyzes, every other caller for that key blocks
on it and reuses its result.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np

from syncaudio.features import DEFAULT_HOP, DEFAULT_N_FFT, ENVELOPE_VERSION, extract_envelope
from syncaudio.ffmpeg_backend import _file_identity, decode_tracks_to_files, extract_pcm, load_pcm_file
from syncaudio.i18n import tr
from syncaudio.models import AudioTrackSpec

# The one sample rate every analysis path (align, segments, render) uses --
# defined here, once, so they can't silently drift apart into separate
# literals that happen to match (they used to be).
ANALYSIS_SAMPLE_RATE = 16000

_MAX_ENTRIES = 64
# Least recently used disk entries are dropped past this: ~150h of audio.
_MAX_DISK_BYTES = 512 * 1024 * 1024

_CacheKey = tuple
_Result = tuple[np.ndarray, float]

_cache: OrderedDict[_CacheKey, _Result] = OrderedDict()
_inflight: dict[_CacheKey, threading.Event] = {}
_lock = threading.Lock()


def _stream_index(spec: AudioTrackSpec) -> int:
    return spec.stream_index if spec.stream_index is not None else 0


def _key(spec: AudioTrackSpec, sample_rate: int, start: float, duration: float | None) -> _CacheKey | None:
    identity = _file_identity(spec.path)
    if identity is None:
        return None  # unreadable: extraction raises its usual error, uncached
    return (*identity, _stream_index(spec), sample_rate, start, duration)


def _app_cache_root(windows_name: str, posix_name: str) -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / windows_name / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / posix_name


def cache_dir() -> Path | None:
    """Where envelopes persist across sessions; ``SYNCAUDIO_CACHE_DIR=""`` disables it."""
    override = os.environ.get("SYNCAUDIO_CACHE_DIR")
    if override is not None:
        return Path(override) if override else None
    return _app_cache_root("Bobine Audio", "bobine-audio") / "envelopes"


def remove_legacy_cache() -> None:
    """Drop the cache kept while the app was named SyncAudio (up to 1.4.x).

    On Windows the installer's run of the old uninstaller already removes
    it; on Linux nothing else would, leaving up to 512MB behind for good.
    Best effort, and never with an explicit ``SYNCAUDIO_CACHE_DIR``.
    """
    if os.environ.get("SYNCAUDIO_CACHE_DIR") is not None:
        return
    legacy = _app_cache_root("SyncAudio", "syncaudio")
    shutil.rmtree(legacy, ignore_errors=True)
    if sys.platform == "win32":
        try:
            legacy.parent.rmdir()  # the old install folder, only if empty
        except OSError:
            pass


def _disk_path(key: _CacheKey) -> Path | None:
    directory = cache_dir()
    if directory is None:
        return None
    digest = hashlib.sha256(repr((ENVELOPE_VERSION, DEFAULT_N_FFT, DEFAULT_HOP, key)).encode()).hexdigest()
    return directory / f"{digest[:32]}.npy"


def _disk_load(key: _CacheKey, sample_rate: int) -> _Result | None:
    path = _disk_path(key)
    if path is None:
        return None
    try:
        env = np.load(path, allow_pickle=False)
        os.utime(path)  # recently used: pruned last
    except (OSError, ValueError):
        return None
    return env, sample_rate / DEFAULT_HOP


def _disk_store(key: _CacheKey, env: np.ndarray) -> None:
    """Best effort: a full disk or read-only profile must never fail an analysis."""
    path = _disk_path(key)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.stem}.{os.getpid()}.{threading.get_ident()}.tmp")
        with open(tmp, "wb") as f:
            np.save(f, env, allow_pickle=False)
        os.replace(tmp, path)
        _prune_disk(path.parent)
    except OSError:
        pass


def _prune_disk(directory: Path) -> None:
    entries = []
    for p in directory.glob("*.npy"):
        try:
            st = p.stat()
        except OSError:
            continue
        entries.append((st.st_mtime, st.st_size, p))
    total = sum(size for _, size, _ in entries)
    for _, size, p in sorted(entries):
        if total <= _MAX_DISK_BYTES:
            break
        try:
            p.unlink()
            total -= size
        except OSError:
            pass


def _remember(key: _CacheKey, result: _Result) -> None:
    _cache[key] = result
    _cache.move_to_end(key)
    while len(_cache) > _MAX_ENTRIES:
        _cache.popitem(last=False)


def _claim(key: _CacheKey, sample_rate: int) -> _Result | threading.Event | None:
    """The cached result, or an Event to wait on (someone else is computing
    it), or None: the caller now owns the key and must ``_release`` it."""
    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached
        event = _inflight.get(key)
        if event is not None:
            return event
        cached = _disk_load(key, sample_rate)
        if cached is not None:
            _remember(key, cached)
            return cached
        _inflight[key] = threading.Event()
        return None


def _release(key: _CacheKey, result: _Result | None) -> None:
    if result is not None:
        _disk_store(key, result[0])
    with _lock:
        if result is not None:
            _remember(key, result)
        event = _inflight.pop(key, None)
    if event is not None:
        event.set()


def _analyze(spec: AudioTrackSpec, pcm: np.ndarray, sample_rate: int, log: Callable[[str], None]) -> _Result:
    log(tr("[analyse] {track} : calcul du spectrogramme et de l'enveloppe...", track=spec.raw))
    return extract_envelope(pcm, sample_rate)


def get_envelope(
    spec: AudioTrackSpec,
    sample_rate: int = ANALYSIS_SAMPLE_RATE,
    start: float = 0.0,
    duration: float | None = None,
    log: Callable[[str], None] = lambda msg: None,
) -> _Result:
    """Return ``(envelope, frame_rate)`` for ``spec``, computing it only on a cache miss."""
    key = _key(spec, sample_rate, start, duration)
    while key is not None:
        claim = _claim(key, sample_rate)
        if claim is None:
            break
        if isinstance(claim, threading.Event):
            log(tr("[cache] {track} : analyse déjà en cours ailleurs, attente...", track=spec.raw))
            claim.wait()
            # Loop back around: the owner either populated the cache (common
            # case) or failed (rare), in which case we become the new owner.
            continue
        log(tr("[cache] {track} déjà analysée, réutilisation", track=spec.raw))
        return claim

    result = None
    try:
        log(tr("[extraction] {track} ...", track=spec.raw))
        pcm = extract_pcm(spec, sample_rate=sample_rate, start=start or None, duration=duration)
        result = _analyze(spec, pcm, sample_rate, log)
        return result
    finally:
        if key is not None:
            _release(key, result)


def prefetch(
    specs: Sequence[AudioTrackSpec],
    sample_rate: int = ANALYSIS_SAMPLE_RATE,
    start: float = 0.0,
    duration: float | None = None,
    log: Callable[[str], None] = lambda msg: None,
) -> None:
    """Warm the cache for all of ``specs``, decoding each file's tracks in one pass.

    Only whole-track analysis is batched: a windowed one seeks per track, and
    each track's seek point depends on its own container delay (see
    ``ffmpeg_backend._seek_args``). Anything not batched, or whose batch
    failed, then goes through ``get_envelope`` one by one as before.
    """
    owned: dict[str, list[tuple[AudioTrackSpec, _CacheKey]]] = {}
    if not start and duration is None:
        for spec in specs:
            key = _key(spec, sample_rate, start, duration)
            if key is not None and _claim(key, sample_rate) is None:
                owned.setdefault(spec.path, []).append((spec, key))

    for path, group in owned.items():
        pending = {key for _, key in group}
        try:
            with tempfile.TemporaryDirectory(prefix="syncaudio-decode-") as tmp:
                log(tr("[extraction] {path} : {count} piste(s) en une seule passe...", path=path, count=len(group)))
                files = decode_tracks_to_files(path, [_stream_index(s) for s, _ in group], sample_rate, Path(tmp))
                for (spec, key), file in zip(group, files):
                    pending.discard(key)
                    result = None
                    try:
                        result = _analyze(spec, load_pcm_file(file), sample_rate, log)
                    finally:
                        _release(key, result)
        except Exception as exc:
            log(tr("[extraction] passe groupée impossible, pistes une par une ({error})", error=exc))
        finally:
            for key in pending:
                _release(key, None)

    for spec in specs:
        get_envelope(spec, sample_rate, start, duration, log=log)


def disk_usage() -> int:
    """Bytes the on-disk cache takes (Options shows it)."""
    directory = cache_dir()
    if directory is None:
        return 0
    total = 0
    for p in directory.glob("*.npy"):
        try:
            total += p.stat().st_size
        except OSError:
            pass
    return total


def clear_disk() -> None:
    """Delete every analysis kept on disk, and in memory (Options' "Vider"):
    the next analysis of each track redoes the work. An analysis running
    meanwhile finishes normally and stores its result as usual."""
    directory = cache_dir()
    with _lock:
        _cache.clear()
    if directory is None:
        return
    for p in directory.glob("*.npy"):
        try:
            p.unlink()
        except OSError:
            pass  # in use: left for the next prune


def clear() -> None:
    """Drop every in-memory entry (mainly for tests, to avoid cross-test leakage)."""
    with _lock:
        _cache.clear()
        _inflight.clear()
