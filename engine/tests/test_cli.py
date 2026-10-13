"""The command line (`syncaudio`), on offset_mkv (its second track 3 s late):
what each command finds and writes, and its errors."""

from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner

from syncaudio.cli import cli
from syncaudio.ffmpeg_backend import probe_audio_streams, probe_duration

runner = CliRunner()


def run(*args: str) -> str:
    result = runner.invoke(cli, list(args), catch_exceptions=False)
    assert result.exit_code == 0, result.output
    return result.stdout


def test_probe_lists_the_tracks(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    out = run("probe", str(mkv))
    assert "jpn" in out and "fre" in out


def test_align_finds_the_offset(offset_mkv: tuple[Path, float]) -> None:
    mkv, offset = offset_mkv
    out = json.loads(run("align", f"{mkv}@0", f"{mkv}@1", "--json", "-q"))
    [track] = out["tracks"]
    assert abs(track["offset_seconds"] - offset) < 0.05


def test_segments_finds_one_constant_segment(offset_mkv: tuple[Path, float]) -> None:
    mkv, offset = offset_mkv
    out = json.loads(run("segments", str(mkv), "--reference", "0", "--track", "1", "--json", "-q"))
    [segment] = out["segments"]
    assert abs(segment["offset_start"] - offset) < 0.05
    assert abs(segment["offset_end"] - offset) < 0.05


def test_render_dry_run_writes_nothing(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    run("render", str(mkv), "--reference", "0", "--track", "1", "--dry-run", "-q")
    assert not mkv.with_name(f"{mkv.stem}.synced.mkv").exists()


def test_render_writes_a_synced_copy(offset_mkv: tuple[Path, float]) -> None:
    mkv, _ = offset_mkv
    out = mkv.with_name("out.mkv")
    run("render", str(mkv), "--reference", "0", "--track", "1", "-o", str(out), "-q")
    assert [s.language for s in probe_audio_streams(str(out))] == ["jpn", "fre"]
    left = json.loads(run("segments", str(out), "--reference", "0", "--track", "1", "--json", "-q"))["segments"]
    assert all(abs(s["offset_start"]) < 0.05 and abs(s["offset_end"]) < 0.05 for s in left)


def test_render_segmented_audio_only(offset_mkv: tuple[Path, float]) -> None:
    """--segmented --audio-only: the corrected track alone, as long as the reference."""
    mkv, _ = offset_mkv
    out = mkv.with_name("tracks.mkv")
    run("render", str(mkv), "--reference", "0", "--track", "1", "--segmented", "--audio-only", "-o", str(out), "-q")
    written = list(mkv.parent.glob("tracks.*.track1.*"))
    assert len(written) == 1
    assert len(probe_audio_streams(str(written[0]))) == 1
    assert abs(probe_duration(str(written[0])) - probe_duration(str(mkv))) < 0.1


def test_an_unreadable_file_is_an_error_not_a_crash(tmp_path: Path) -> None:
    bad = tmp_path / "bad.mkv"
    bad.write_text("not a video")
    result = runner.invoke(cli, ["probe", str(bad)])
    assert result.exit_code != 0
    assert result.exception is None or isinstance(result.exception, SystemExit)
