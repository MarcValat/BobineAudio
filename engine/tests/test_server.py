from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import syncaudio.analysis_cache as analysis_cache
import syncaudio.waveform_cache as waveform_cache
from syncaudio.ffmpeg_backend import probe_audio_streams, resolve_ffmpeg
from syncaudio.server import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_analysis_cache():
    analysis_cache.clear()
    waveform_cache.clear()
    yield
    analysis_cache.clear()
    waveform_cache.clear()


def _make_bed(duration_s: float, sr: int, seed: int, hits_per_second: float = 3.0) -> np.ndarray:
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


def _write_wav(path: Path, data: np.ndarray, sr: int) -> None:
    samples = np.clip(data * 20000, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(samples.tobytes())


@pytest.fixture()
def offset_mkv(tmp_path: Path) -> tuple[Path, float]:
    """A 2-track mkv (dummy video + reference + candidate lagging by 3s)."""
    sr = 44100
    duration_s = 30.0
    offset_s = 3.0

    bed = _make_bed(duration_s, sr, seed=42)
    shifted = np.concatenate([np.zeros(int(offset_s * sr)), bed])[: len(bed)]

    ref_wav = tmp_path / "ref.wav"
    cand_wav = tmp_path / "cand.wav"
    _write_wav(ref_wav, bed, sr)
    _write_wav(cand_wav, shifted, sr)

    mkv = tmp_path / "multi.mkv"
    ffmpeg = resolve_ffmpeg()
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s=64x64:d={duration_s}",
            "-i", str(ref_wav), "-i", str(cand_wav),
            "-map", "0:v", "-map", "1:a", "-map", "2:a",
            "-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=fre",
            "-shortest", str(mkv),
        ],
        check=True, capture_output=True,
    )
    return mkv, offset_s


def test_health() -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_probe_lists_tracks(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.get("/probe", params={"path": str(mkv)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == str(mkv)
    assert [t["index"] for t in body["tracks"]] == [0, 1]
    assert [t["language"] for t in body["tracks"]] == ["jpn", "fre"]
    assert [t["start_time"] for t in body["tracks"]] == [0.0, 0.0]  # no container-level delay here


def test_probe_reports_container_level_track_delay(tmp_path: Path) -> None:
    ffmpeg = resolve_ffmpeg()
    sr = 44100
    wav_a = tmp_path / "a.wav"
    wav_b = tmp_path / "b.wav"
    _write_wav(wav_a, _make_bed(2.0, sr, seed=1), sr)
    _write_wav(wav_b, _make_bed(2.0, sr, seed=2), sr)

    mkv = tmp_path / "delayed.mkv"
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=64x64:d=3",
            "-i", str(wav_a),
            "-itsoffset", "1.0", "-i", str(wav_b),
            "-map", "0:v", "-map", "1:a", "-map", "2:a",
            "-shortest", str(mkv),
        ],
        check=True, capture_output=True,
    )

    resp = client.get("/probe", params={"path": str(mkv)})
    assert resp.status_code == 200
    body = resp.json()
    assert abs(body["tracks"][0]["start_time"] - 0.0) < 0.05
    assert abs(body["tracks"][1]["start_time"] - 1.0) < 0.05


def test_probe_lists_subtitle_tracks(offset_mkv: tuple[Path, float], tmp_path: Path) -> None:
    mkv, _ = offset_mkv
    srt = tmp_path / "subs.srt"
    srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nBonjour\n", encoding="utf-8")
    with_subs = tmp_path / "with_subs.mkv"
    subprocess.run(
        [
            resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(mkv), "-i", str(srt), "-i", str(srt), "-i", str(srt),
            "-map", "0", "-map", "1", "-map", "2", "-map", "3", "-c", "copy", "-c:s", "srt",
            "-metadata:s:s:0", "language=fre", "-metadata:s:s:0", "title=Français",
            "-metadata:s:s:1", "language=fre", "-disposition:s:1", "forced",
            "-metadata:s:s:2", "language=eng", "-metadata:s:s:2", "title=English Forced",
            str(with_subs),
        ],
        check=True, capture_output=True,
    )
    resp = client.get("/probe", params={"path": str(with_subs)})
    assert resp.status_code == 200
    subs = resp.json()["subtitles"]
    assert [(s["index"], s["language"], s["forced"], s["shiftable"]) for s in subs] == [
        (0, "fre", False, True),
        (1, "fre", True, True),  # by disposition
        (2, "eng", True, True),  # by title only
    ]
    assert subs[0]["title"] == "Français"


def test_probe_missing_file_returns_400() -> None:
    resp = client.get("/probe", params={"path": "does-not-exist.mkv"})
    assert resp.status_code == 400


def test_clip_endpoint_returns_a_playable_wav(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.get("/clip", params={"path": str(mkv), "index": 0, "start": 1.0, "duration": 2.0})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content[:4] == b"RIFF"
    assert resp.content[8:12] == b"WAVE"


def test_clip_endpoint_caps_duration(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.get("/clip", params={"path": str(mkv), "index": 0, "start": 0.0, "duration": 9999})
    assert resp.status_code == 200
    # Generous upper bound for a capped ~30s clip -- mainly guards against
    # silently honoring an absurd duration request.
    assert len(resp.content) < 10_000_000


def test_clip_endpoint_missing_file_returns_400() -> None:
    resp = client.get("/clip", params={"path": "does-not-exist.mkv", "index": 0})
    assert resp.status_code == 400


def test_corrected_clip_endpoint_returns_a_playable_wav(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    segments = [
        {"start_s": 0.0, "end_s": 2.0, "offset_start": 0.0, "offset_end": 0.0, "is_drift": False},
        {"start_s": 2.0, "end_s": 4.0, "offset_start": 0.5, "offset_end": 0.5, "is_drift": False},
    ]
    resp = client.post(
        "/corrected-clip", json={"path": str(mkv), "index": 1, "segments": segments, "start": 1.0, "duration": 2.0}
    )
    assert resp.status_code == 200
    assert resp.content[:4] == b"RIFF"


def test_corrected_clip_endpoint_without_segments_returns_400(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.post("/corrected-clip", json={"path": str(mkv), "index": 1, "segments": [], "start": 0.0})
    assert resp.status_code == 400


def test_waveform_endpoint_returns_bucketed_peaks(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.get("/waveform", params={"path": str(mkv), "index": 0, "buckets": 40})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["peaks_min"]) == 40
    assert len(body["peaks_max"]) == 40
    assert abs(body["duration"] - 30.0) < 0.5  # offset_mkv is a 30s fixture


def test_waveform_endpoint_windowed(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    resp = client.get("/waveform", params={"path": str(mkv), "index": 0, "start": 5.0, "duration": 2.0, "buckets": 20})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["peaks_min"]) == 20
    assert abs(body["duration"] - 2.0) < 0.2


def test_waveform_endpoint_missing_file_returns_400() -> None:
    resp = client.get("/waveform", params={"path": "does-not-exist.mkv", "index": 0})
    assert resp.status_code == 400


def _drain_job_ws(job_id: str) -> list[dict]:
    events = []
    with client.websocket_connect(f"/jobs/{job_id}/ws") as ws:
        while True:
            event = ws.receive_json()
            events.append(event)
            if event["type"] in ("done", "error", "cancelled"):
                break
    return events


def _run_job(route: str, payload: dict) -> list[dict]:
    """Start a job and return every event it streamed, the final done/error last."""
    resp = client.post(route, json=payload)
    assert resp.status_code == 200
    return _drain_job_ws(resp.json()["job_id"])


def _logs(events: list[dict]) -> list[str]:
    return [e["message"] for e in events if e["type"] == "log"]


def _segments_payload(mkv: Path) -> dict:
    return {
        "reference": {"path": str(mkv), "index": 0},
        "track": {"path": str(mkv), "index": 1},
        "window_s": 10.0,
        "hop_s": 5.0,
        "margin_s": 5.0,
    }


def test_job_segments_streams_progress_then_segments(offset_mkv: tuple[Path, float]) -> None:
    mkv, offset_s = offset_mkv
    events = _run_job("/jobs/segments", _segments_payload(mkv))
    assert _logs(events)  # got at least one progress message
    assert events[-1]["type"] == "done"
    segments = events[-1]["result"]["segments"]
    assert len(segments) >= 1
    assert abs(segments[0]["offset_start"] - offset_s) < 0.5


def test_job_render_writes_a_corrected_file(offset_mkv: tuple[Path, float]) -> None:
    mkv, offset_s = offset_mkv
    output_path = str(mkv.with_name("out.synced.mkv"))
    events = _run_job(
        "/jobs/render",
        {"input_path": str(mkv), "reference_index": 0, "track_indices": [1], "output_path": output_path},
    )
    assert _logs(events)
    assert events[-1]["type"] == "done"
    result = events[-1]["result"]
    assert result["written"] == [output_path]
    assert Path(output_path).exists()
    assert len(result["corrections"]) == 1
    assert abs(result["corrections"][0]["offset_seconds"] - offset_s) < 0.1


def test_job_render_segmented(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    output_path = str(mkv.with_name("out.segmented.mkv"))
    events = _run_job(
        "/jobs/render",
        {
            "input_path": str(mkv),
            "reference_index": 0,
            "track_indices": [1],
            "output_path": output_path,
            "segmented": True,
            "window_s": 10.0,
            "hop_s": 5.0,
            "margin_s": 5.0,
        },
    )
    assert events[-1]["type"] == "done"
    result = events[-1]["result"]
    assert result["written"] == [output_path]
    assert result["corrections"][0]["segments"] is not None
    assert result["corrections"][0]["offset_seconds"] is None


def test_job_render_segmented_uses_supplied_segment_override(offset_mkv: tuple[Path, float]) -> None:
    """A caller that already ran /jobs/segments and let the user edit the
    result (SegmentEditor.tsx) must get exactly those segments rendered, not
    a fresh, silently-recomputed detect_segments() that discards the edits."""
    mkv, _offset_s = offset_mkv
    output_path = str(mkv.with_name("out.override.mkv"))
    # Deliberately wrong/made-up offset, distinguishable from the real ~3s:
    # if this shows up in the render instead of the real offset, the
    # override was honored rather than ignored in favor of auto-detection.
    fake_offset = 1.0
    segment = {"start_s": 0.0, "end_s": 30.0, "offset_start": fake_offset, "offset_end": fake_offset, "is_drift": False}
    events = _run_job(
        "/jobs/render",
        {
            "input_path": str(mkv),
            "reference_index": 0,
            "track_indices": [1],
            "output_path": output_path,
            "segmented": True,
            "segment_overrides": [{"track": {"path": str(mkv), "index": 1}, "segments": [segment]}],
        },
    )
    assert events[-1]["type"] == "done"
    result = events[-1]["result"]
    assert result["written"] == [output_path]
    assert result["corrections"][0]["segments"] == [{**segment, "confidence": 1.0}]
    assert any("segments fournis" in m for m in _logs(events))


def test_job_render_tags_an_imported_audio_file_with_the_given_language(offset_mkv: tuple[Path, float]) -> None:
    """A bare .wav has no language: the one given with its segments is what
    the corrected track gets in the output."""
    mkv, _ = offset_mkv
    wav = mkv.with_name("cand.wav")
    output_path = str(mkv.with_name("out.imported.mkv"))
    segment = {"start_s": 0.0, "end_s": 30.0, "offset_start": 3.0, "offset_end": 3.0, "is_drift": False}
    events = _run_job(
        "/jobs/render",
        {
            "input_path": str(mkv),
            "reference_index": 0,
            "only_imports": True,
            "import_audio": [{"path": str(wav), "index": 0}],
            "output_path": output_path,
            "segmented": True,
            "segment_overrides": [{"track": {"path": str(wav), "index": 0}, "segments": [segment], "language": "ger"}],
        },
    )
    assert events[-1]["type"] == "done", events[-1]
    streams = probe_audio_streams(output_path)
    assert [s.language for s in streams] == ["jpn", "ger"]


def test_job_render_unknown_track_reports_a_readable_error(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    events = _run_job("/jobs/render", {"input_path": str(mkv), "reference_index": 0, "track_indices": [7]})
    assert events[-1]["type"] == "error"
    assert events[-1]["message"].startswith("Index(es) inconnu(s)")  # the detail alone, no "400: " prefix


def test_job_ws_unknown_job_id_reports_error() -> None:
    with client.websocket_connect("/jobs/does-not-exist/ws") as ws:
        event = ws.receive_json()
    assert event["type"] == "error"


def test_job_error_is_reported_not_left_hanging() -> None:
    resp = client.post(
        "/jobs/render",
        json={"input_path": "does-not-exist.mkv", "reference_index": 0},
    )
    job_id = resp.json()["job_id"]
    events = _drain_job_ws(job_id)
    assert events[-1]["type"] == "error"


def test_prefetch_warms_the_cache_for_a_later_detection(offset_mkv: tuple[Path, float]) -> None:
    mkv, offset_s = offset_mkv

    events = _run_job("/jobs/prefetch", {"tracks": [{"path": str(mkv), "index": 0}, {"path": str(mkv), "index": 1}]})
    assert events[-1]["type"] == "done"
    assert events[-1]["result"]["cached"] == 2
    # Both tracks were freshly extracted (no prior cache) -> real work happened.
    assert any("[extraction]" in m for m in _logs(events))

    # A subsequent detection on the very same tracks should be served
    # entirely from cache -- no further extraction, and the result is
    # unaffected.
    events = _run_job("/jobs/segments", _segments_payload(mkv))
    assert events[-1]["type"] == "done"
    assert not any("[extraction]" in m for m in _logs(events))
    assert any("[cache]" in m for m in _logs(events))
    assert abs(events[-1]["result"]["segments"][0]["offset_start"] - offset_s) < 0.5


def test_a_cancelled_job_reports_it_and_its_ffmpeg_stops() -> None:
    from syncaudio.ffmpeg_backend import _run
    from syncaudio.jobs import start_job

    cmd = [resolve_ffmpeg(), "-hide_banner", "-re", "-f", "lavfi", "-i", "sine=duration=60", "-f", "null", "-"]
    job = start_job(lambda log: _run(cmd, capture_output=True))
    assert client.post(f"/jobs/{job.id}/cancel").status_code == 200
    events = _drain_job_ws(job.id)
    assert events[-1]["type"] == "cancelled"


def test_cancel_unknown_job_returns_404() -> None:
    assert client.post("/jobs/does-not-exist/cancel").status_code == 404


def test_paths_exist_answers_in_order(tmp_path: Path) -> None:
    taken = tmp_path / "Episode 1.mkv"
    taken.write_bytes(b"")
    resp = client.post("/paths/exist", json={"paths": [str(tmp_path / "Episode 2.mkv"), str(taken)]})
    assert resp.status_code == 200
    assert resp.json() == {"exists": [False, True]}


def test_cache_size_and_clearing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = tmp_path / "cache" / "envelopes"
    monkeypatch.setenv("SYNCAUDIO_CACHE_DIR", str(folder))
    assert client.get("/cache").json() == {"bytes": 0}  # not created yet
    folder.mkdir(parents=True)
    (folder / "a.npy").write_bytes(b"x" * 1000)
    (folder / "b.npy").write_bytes(b"x" * 500)
    assert client.get("/cache").json() == {"bytes": 1500}
    assert client.delete("/cache").json() == {"bytes": 0}
    assert list(folder.iterdir()) == []


def test_paths_expand_lists_a_folders_media_files_in_episode_order(tmp_path: Path) -> None:
    folder = tmp_path / "Show"
    (folder / "Extras").mkdir(parents=True)
    for name in ["Episode 10.mkv", "Episode 2.MKV", "Episode 1.mp4", "notes.txt", "Extras/Making of.mkv"]:
        (folder / name).write_bytes(b"")
    loose = tmp_path / "loose.txt"
    loose.write_bytes(b"")

    resp = client.post(
        "/paths/expand",
        json={"paths": [str(loose), str(folder), str(tmp_path / "gone.mkv")], "extensions": ["mkv", "mp4"]},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "files": [str(loose)] + [str(folder / n) for n in ["Episode 1.mp4", "Episode 2.MKV", "Episode 10.mkv"]]
    }


def test_a_cancelled_export_leaves_no_partial_file(offset_mkv: tuple[Path, float], monkeypatch: pytest.MonkeyPatch) -> None:
    import syncaudio.server as server
    from syncaudio.cancellation import Cancelled

    mkv, _ = offset_mkv
    output_path = mkv.with_name("out.partial.mkv")

    def render_cut_short(*args, **kwargs):
        output_path.write_bytes(b"half a file")
        raise Cancelled()

    monkeypatch.setattr(server, "render_tracks", render_cut_short)
    segment = {"start_s": 0.0, "end_s": 30.0, "offset_start": 3.0, "offset_end": 3.0, "is_drift": False}
    events = _run_job(
        "/jobs/render",
        {
            "input_path": str(mkv),
            "reference_index": 0,
            "track_indices": [1],
            "output_path": str(output_path),
            "segmented": True,
            "segment_overrides": [{"track": {"path": str(mkv), "index": 1}, "segments": [segment]}],
        },
    )
    assert events[-1]["type"] == "cancelled"
    assert not output_path.exists()
