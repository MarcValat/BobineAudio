from __future__ import annotations

import threading
import time
import wave
from pathlib import Path

import numpy as np
import pytest

import syncaudio.waveform_cache as waveform_cache
from syncaudio.models import AudioTrackSpec
from syncaudio.waveform_cache import get_peaks


@pytest.fixture(autouse=True)
def _clear_cache():
    waveform_cache.clear()
    yield
    waveform_cache.clear()


@pytest.fixture()
def tone_wav(tmp_path: Path) -> Path:
    sr = 16000
    duration_s = 3.0
    n = int(sr * duration_s)
    t = np.arange(n) / sr
    samples = (0.5 * np.sin(2 * np.pi * 440.0 * t) * 32767).astype("<i2")
    path = tmp_path / "tone.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(samples.tobytes())
    return path


def test_second_call_is_a_cache_hit_and_skips_extraction(tone_wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)

    calls = []
    real_extract_peaks = waveform_cache.extract_peaks

    def counting_extract_peaks(*args, **kwargs):
        calls.append(1)
        return real_extract_peaks(*args, **kwargs)

    monkeypatch.setattr(waveform_cache, "extract_peaks", counting_extract_peaks)

    mins1, maxes1, dur1 = get_peaks(spec, buckets=100)
    assert len(calls) == 1

    mins2, maxes2, dur2 = get_peaks(spec, buckets=100)
    assert len(calls) == 1  # no new decode on the second call
    assert dur1 == dur2
    assert np.array_equal(mins1, mins2)
    assert np.array_equal(maxes1, maxes2)


def test_different_bucket_count_is_a_different_cache_entry(tone_wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A waveform at a different resolution is genuinely different data --
    caching must not serve one bucket count's result for another."""
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)

    calls = []
    real_extract_peaks = waveform_cache.extract_peaks

    def counting_extract_peaks(*args, **kwargs):
        calls.append(1)
        return real_extract_peaks(*args, **kwargs)

    monkeypatch.setattr(waveform_cache, "extract_peaks", counting_extract_peaks)

    mins_coarse, _, _ = get_peaks(spec, buckets=50)
    mins_fine, _, _ = get_peaks(spec, buckets=200)
    assert len(calls) == 2
    assert len(mins_coarse) == 50
    assert len(mins_fine) == 200


def test_concurrent_calls_for_the_same_key_decode_only_once(tone_wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)

    calls = []
    real_extract_peaks = waveform_cache.extract_peaks

    def slow_extract_peaks(*args, **kwargs):
        calls.append(1)
        time.sleep(0.3)  # wide enough for the second thread to reliably start before this returns
        return real_extract_peaks(*args, **kwargs)

    monkeypatch.setattr(waveform_cache, "extract_peaks", slow_extract_peaks)

    results: list[tuple[np.ndarray, np.ndarray, float]] = []

    def worker():
        results.append(get_peaks(spec, buckets=100))

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    time.sleep(0.05)  # let t1 claim ownership of the key before t2 starts
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert len(calls) == 1  # only the owner actually decoded
    assert len(results) == 2
    assert np.array_equal(results[0][0], results[1][0])
