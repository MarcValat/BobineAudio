from __future__ import annotations

import subprocess
import threading
import time
import wave
from pathlib import Path

import numpy as np
import pytest

import syncaudio.analysis_cache as analysis_cache
from syncaudio.analysis_cache import get_envelope
from syncaudio.ffmpeg_backend import resolve_ffmpeg
from syncaudio.models import AudioTrackSpec


@pytest.fixture(autouse=True)
def _clear_cache():
    analysis_cache.clear()
    yield
    analysis_cache.clear()


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
    real_extract_pcm = analysis_cache.extract_pcm

    def counting_extract_pcm(*args, **kwargs):
        calls.append(1)
        return real_extract_pcm(*args, **kwargs)

    monkeypatch.setattr(analysis_cache, "extract_pcm", counting_extract_pcm)

    env1, rate1 = get_envelope(spec)
    assert len(calls) == 1

    env2, rate2 = get_envelope(spec)
    assert len(calls) == 1  # no new extraction on the second call
    assert rate1 == rate2
    assert np.array_equal(env1, env2)


def test_cache_reports_hits_and_misses_via_log(tone_wav: Path) -> None:
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)
    messages: list[str] = []

    get_envelope(spec, log=messages.append)
    assert any("[extraction]" in m for m in messages)
    assert not any("[cache]" in m for m in messages)

    messages.clear()
    get_envelope(spec, log=messages.append)
    assert any("[cache]" in m for m in messages)
    assert not any("[extraction]" in m for m in messages)


def test_different_track_index_is_a_different_cache_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sr = 16000
    duration_s = 2.0
    ffmpeg = resolve_ffmpeg()

    def make_wav(path: Path, freq: float) -> None:
        n = int(sr * duration_s)
        t = np.arange(n) / sr
        samples = (0.5 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2")
        with wave.open(str(path), "wb") as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(sr)
            f.writeframes(samples.tobytes())

    wav_a = tmp_path / "a.wav"
    wav_b = tmp_path / "b.wav"
    make_wav(wav_a, 440.0)
    make_wav(wav_b, 880.0)

    mkv = tmp_path / "multi.mkv"
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(wav_a), "-i", str(wav_b),
            "-map", "0:a", "-map", "1:a",
            str(mkv),
        ],
        check=True, capture_output=True,
    )

    calls = []
    real_extract_pcm = analysis_cache.extract_pcm

    def counting_extract_pcm(*args, **kwargs):
        calls.append(1)
        return real_extract_pcm(*args, **kwargs)

    monkeypatch.setattr(analysis_cache, "extract_pcm", counting_extract_pcm)

    get_envelope(AudioTrackSpec(raw=f"{mkv}@0", path=str(mkv), stream_index=0))
    get_envelope(AudioTrackSpec(raw=f"{mkv}@1", path=str(mkv), stream_index=1))
    assert len(calls) == 2  # two distinct tracks -> two distinct cache entries, no false-positive hit


def test_concurrent_calls_for_the_same_key_extract_only_once(tone_wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression test: a caller starting mid-way through another caller's
    in-progress extraction (e.g. a user click racing a background prefetch
    for the same track) used to redundantly redo the whole ~7s of work
    instead of waiting for and reusing the first one's result."""
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)

    calls = []
    real_extract_pcm = analysis_cache.extract_pcm

    def slow_extract_pcm(*args, **kwargs):
        calls.append(1)
        time.sleep(0.3)  # wide enough for the second thread to reliably start before this returns
        return real_extract_pcm(*args, **kwargs)

    monkeypatch.setattr(analysis_cache, "extract_pcm", slow_extract_pcm)

    results: list[tuple[np.ndarray, float]] = []

    def worker():
        results.append(get_envelope(spec))

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    time.sleep(0.05)  # let t1 claim ownership of the key before t2 starts
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert len(calls) == 1  # only the owner actually extracted
    assert len(results) == 2
    assert np.array_equal(results[0][0], results[1][0])


def _counting(monkeypatch: pytest.MonkeyPatch, name: str) -> list[int]:
    calls: list[int] = []
    real = getattr(analysis_cache, name)

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(analysis_cache, name, counting)
    return calls


def test_disk_cache_survives_a_new_session(tone_wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SYNCAUDIO_CACHE_DIR", str(tmp_path / "cache"))
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)
    env1, rate1 = get_envelope(spec)

    analysis_cache.clear()  # what a restarted engine starts with
    calls = _counting(monkeypatch, "extract_pcm")
    env2, rate2 = get_envelope(spec)
    assert calls == []
    assert rate1 == rate2
    assert np.array_equal(env1, env2)


def test_a_changed_file_is_analyzed_again(tone_wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SYNCAUDIO_CACHE_DIR", str(tmp_path / "cache"))
    spec = AudioTrackSpec(raw=str(tone_wav), path=str(tone_wav), stream_index=None)
    get_envelope(spec)

    with wave.open(str(tone_wav), "wb") as f:  # replaced by different, longer audio
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(np.zeros(16000 * 4, dtype="<i2").tobytes())
    analysis_cache.clear()
    calls = _counting(monkeypatch, "extract_pcm")
    env, _ = get_envelope(spec)
    assert calls == [1]
    assert not env.any()


def test_prefetch_decodes_a_file_once_for_all_its_tracks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ffmpeg = resolve_ffmpeg()
    mkv = tmp_path / "multi.mkv"
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-f", "lavfi", "-i", "anoisesrc=duration=3:seed=7",
            "-map", "0:a", "-map", "1:a", "-c:a", "flac", str(mkv),
        ],
        check=True, capture_output=True,
    )
    specs = [AudioTrackSpec(raw=f"{mkv}@{i}", path=str(mkv), stream_index=i) for i in (0, 1)]
    expected = [get_envelope(s)[0] for s in specs]
    analysis_cache.clear()

    batch_calls = _counting(monkeypatch, "decode_tracks_to_files")
    single_calls = _counting(monkeypatch, "extract_pcm")
    analysis_cache.prefetch(specs)
    assert batch_calls == [1]
    assert single_calls == []
    for spec, env in zip(specs, expected):
        assert np.array_equal(get_envelope(spec)[0], env)


def _point_cache_roots_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SYNCAUDIO_CACHE_DIR")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))


def test_cache_dir_follows_the_bobine_audio_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_cache_roots_at(tmp_path, monkeypatch)
    for platform, expected in (("win32", tmp_path / "Bobine Audio" / "cache"), ("linux", tmp_path / "bobine-audio")):
        monkeypatch.setattr(analysis_cache.sys, "platform", platform)
        assert analysis_cache.cache_dir() == expected / "envelopes"


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_remove_legacy_cache_drops_the_syncaudio_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, platform: str) -> None:
    _point_cache_roots_at(tmp_path, monkeypatch)
    monkeypatch.setattr(analysis_cache.sys, "platform", platform)
    legacy = tmp_path / "SyncAudio" / "cache" if platform == "win32" else tmp_path / "syncaudio"
    (legacy / "envelopes").mkdir(parents=True)
    (legacy / "envelopes" / "old.npy").write_bytes(b"x")
    current = analysis_cache.cache_dir()
    current.mkdir(parents=True)

    analysis_cache.remove_legacy_cache()

    assert not legacy.exists()
    assert not (tmp_path / "SyncAudio").exists()
    assert current.is_dir()


def test_remove_legacy_cache_leaves_an_explicit_cache_dir_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    legacy = tmp_path / "SyncAudio" / "cache" if analysis_cache.sys.platform == "win32" else tmp_path / "syncaudio"
    legacy.mkdir(parents=True)
    analysis_cache.remove_legacy_cache()  # SYNCAUDIO_CACHE_DIR="" from conftest
    assert legacy.is_dir()
