from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np

from syncaudio.cancellation import Cancelled, current_cancel_event
from syncaudio.i18n import tr
from syncaudio.models import AudioStreamInfo, AudioTrackSpec, SubtitleStreamInfo

# A packaged sidecar build has no console of its own (see
# engine/packaging/ -- built windowed, so the app doesn't flash a terminal
# behind the GUI). ffmpeg is a console-subsystem exe, so without this,
# every single probe/extract/render call spawns a brand new console window
# that flickers open and closed -- invisible in dev, where the sidecar
# itself already runs inside a real terminal and children just share it,
# only surfacing once actually packaged (a real user report, not a
# hypothetical).
_SUBPROCESS_FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _run(*args, **kwargs) -> subprocess.CompletedProcess:
    """`subprocess.run`, but never flashes a console window on Windows, and
    stops (raising ``Cancelled``) as soon as the job running it is cancelled."""
    kwargs.setdefault("creationflags", _SUBPROCESS_FLAGS)
    event = current_cancel_event()
    if event is None:
        return subprocess.run(*args, **kwargs)
    return _run_cancellable(event, *args, **kwargs)


# How often a running ffmpeg checks for a cancellation.
_CANCEL_POLL_S = 0.2


def _run_cancellable(event, cmd, *, capture_output=False, check=False, input=None, **kwargs) -> subprocess.CompletedProcess:
    """``subprocess.run(cmd, ...)``, killing the process once ``event`` is set."""
    if event.is_set():
        raise Cancelled()
    if capture_output:
        kwargs["stdout"] = kwargs["stderr"] = subprocess.PIPE
    if input is not None:
        kwargs["stdin"] = subprocess.PIPE
    with subprocess.Popen(cmd, **kwargs) as proc:
        pending = input
        while True:
            try:
                out, err = proc.communicate(pending, timeout=_CANCEL_POLL_S)
                break
            except subprocess.TimeoutExpired:
                # Already sent: retrying only goes on reading, nothing is lost.
                pending = None
                if event.is_set():
                    proc.kill()
                    proc.communicate()
                    raise Cancelled() from None
    result = subprocess.CompletedProcess(cmd, proc.returncode, out, err)
    if check:
        result.check_returncode()
    return result

_STREAM_RE = re.compile(
    r"^\s*Stream #\d+:(?P<index>\d+)(?:\((?P<lang>[^)]+)\))?:\s*Audio:\s*"
    r"(?P<codec>[^,]+),\s*(?P<rate>\d+)\s*Hz,\s*(?P<channels>[^,]+)"
)
_DURATION_RE = re.compile(r"Duration:\s*(?P<h>\d+):(?P<m>\d+):(?P<s>\d+(?:\.\d+)?)")
_DURATION_START_RE = re.compile(r"Duration:\s*\d+:\d+:\d+(?:\.\d+)?,\s*start:\s*(?P<start>-?\d+(?:\.\d+)?)")
_SUBTITLE_STREAM_RE = re.compile(r"^\s*Stream #\d+:(?P<index>\d+)(?:\([^)]+\))?:\s*Subtitle:\s*(?P<codec>\S+)")
_BITRATE_RE = re.compile(r"(?P<kbps>\d+)\s*kb/s")
# The container's codec tag ffmpeg appends to some codec names, e.g.
# "pcm_s16le ([1][0][0][0] / 0x0001)" for a .wav: noise to anyone reading it.
_CODEC_TAG_RE = re.compile(r"\s*\(\[[^()]*/ 0x[0-9A-Fa-f]+\)")


class FFmpegError(RuntimeError):
    """Raised when the ffmpeg binary is missing or a media operation fails."""


@lru_cache(maxsize=1)
def resolve_ffmpeg() -> str:
    """Locate an ffmpeg executable: prefer one on PATH, else the bundled one."""
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - defensive
        raise FFmpegError(
            tr("ffmpeg introuvable : ni sur le PATH, ni via le paquet imageio-ffmpeg.")
        ) from exc


def _file_identity(path: str) -> tuple[str, int, int] | None:
    """What a cached probe of ``path`` is only valid for: the same file, unchanged."""
    try:
        st = Path(path).stat()
    except OSError:
        return None
    return str(Path(path).resolve()), st.st_size, st.st_mtime_ns


@lru_cache(maxsize=64)
def _ffmpeg_info_cached(path: str, identity: tuple[str, int, int]) -> str:
    return _ffmpeg_info_uncached(path)


def _ffmpeg_info_uncached(path: str) -> str:
    proc = _run([resolve_ffmpeg(), "-hide_banner", "-i", path], capture_output=True)
    return proc.stderr.decode("utf-8", errors="replace")


def _ffmpeg_info(path: str) -> str:
    """``ffmpeg -i path``'s report (stderr), decoded as UTF-8.

    Every probe below parses this same report, and a single open/render
    asks for it many times over: it's read once per unchanged file instead.
    UTF-8 explicitly, as ffmpeg writes tags that way (the platform default,
    cp1252 on Windows, would mangle accented titles).
    """
    identity = _file_identity(path)
    return _ffmpeg_info_uncached(path) if identity is None else _ffmpeg_info_cached(path, identity)


def parse_track_spec(raw: str) -> AudioTrackSpec:
    """Parse a CLI track argument: ``path`` or ``path@INDEX``.

    ``@`` is used as separator (rather than ``:``) so Windows drive letters
    like ``C:\\...`` are never ambiguous.
    """
    if "@" in raw:
        path, _, index_str = raw.rpartition("@")
        try:
            index = int(index_str)
        except ValueError as exc:
            raise ValueError(
                tr("Index de piste invalide dans {raw!r} : {index!r} n'est pas un entier.", raw=raw, index=index_str)
            ) from exc
        return AudioTrackSpec(raw=raw, path=path, stream_index=index)
    return AudioTrackSpec(raw=raw, path=raw, stream_index=None)


def probe_audio_streams(path: str) -> list[AudioStreamInfo]:
    """List the audio streams of a media file.

    The returned ``index`` is 0-based among *audio* streams only (matching
    ffmpeg's ``-map 0:a:N`` selector), not the container's global stream index.
    """
    stderr = _ffmpeg_info(path)
    if "Invalid data found" in stderr or "No such file or directory" in stderr:
        raise FFmpegError(tr("Impossible de lire {path!r} :\n{details}", path=path, details=stderr))

    tags = probe_stream_tags(path, "Audio")
    streams: list[AudioStreamInfo] = []
    for line in stderr.splitlines():
        match = _STREAM_RE.match(line)
        if not match:
            continue
        channels_raw = match.group("channels").strip()
        channels = _CHANNEL_LAYOUTS.get(channels_raw)
        bitrate_match = _BITRATE_RE.search(line)
        streams.append(
            AudioStreamInfo(
                index=len(streams),
                codec=_CODEC_TAG_RE.sub("", match.group("codec")).strip(),
                language=match.group("lang"),
                channels=channels,
                sample_rate=int(match.group("rate")),
                bit_rate=int(bitrate_match["kbps"]) * 1000 if bitrate_match else None,
                title=tags[len(streams)].get("title") if len(streams) < len(tags) else None,
            )
        )
    if not streams:
        raise FFmpegError(tr("Aucune piste audio trouvée dans {path!r}.", path=path))
    return streams


def probe_duration(path: str) -> float:
    """Return the container's total duration in seconds, as reported by ffmpeg."""
    match = _DURATION_RE.search(_ffmpeg_info(path))
    if not match:
        raise FFmpegError(tr("Impossible de déterminer la durée de {path!r}.", path=path))
    return int(match["h"]) * 3600 + int(match["m"]) * 60 + float(match["s"])


def probe_stream_start_time(path: str, stream_index: int) -> float:
    """Container-level presentation delay of one audio stream (0.0 if none).

    A track remuxed with a per-track delay (e.g. mkvtoolnix's ``--sync``, or
    any tool that shifts a track's block timestamps instead of re-encoding
    it) only starts *presenting* at this offset. ffmpeg handles it
    inconsistently when decoding to raw audio (verified empirically): with
    no ``-ss``, or ``-ss`` below the delay, output starts at the track's
    first sample (delay dropped); with ``-ss T`` at or past the delay, it
    lands on own-time ``T - delay`` (delay honored). See ``_seek_args``,
    which uses this value to keep every windowed extraction in the track's
    own timeline.

    Method: ffmpeg's default output muxing normalizes away a stream's start
    time (``-avoid_negative_ts make_zero``); isolating the stream into its
    own container with ``-copyts`` (which disables that) and re-probing it
    reveals ffmpeg's own internal understanding of the delay. The delay is
    fixed at the stream's very first packet, so ``-t`` caps the copy to a
    few seconds instead of the whole track -- this runs synchronously inside
    ``/probe``, once per track, before the GUI can show anything, so it must
    stay fast even on a multi-hour file (unlike the prefetch that follows
    `/probe`, which deliberately does decode every track in full, but in the
    background, after the track list is already on screen). Best-effort:
    returns 0.0 on any failure rather than raising, since this must never
    break the actual detection/render pipeline it's decoupled from.
    """
    return _probe_stream_start_time(path, stream_index, _file_identity(path))


@lru_cache(maxsize=256)
def _probe_stream_start_time(path: str, stream_index: int, identity: tuple[str, int, int] | None) -> float:
    ffmpeg = resolve_ffmpeg()
    with tempfile.TemporaryDirectory(prefix="syncaudio-starttime-") as tmp_dir:
        tmp_path = str(Path(tmp_dir) / "probe.mka")
        extract = _run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-i", path, "-map", f"0:a:{stream_index}", "-c", "copy", "-copyts", "-t", "5", tmp_path,
            ],
            capture_output=True,
        )
        if extract.returncode != 0:
            return 0.0
        probe = _run([ffmpeg, "-hide_banner", "-i", tmp_path], capture_output=True, text=True)
        match = _DURATION_START_RE.search(probe.stderr)
        return float(match["start"]) if match else 0.0


def _seek_args(spec: AudioTrackSpec, start: float) -> list[str]:
    """``-ss`` args landing on ``start`` in the track's own timeline.

    Whole-track extraction (detection, waveforms) always sees the track from
    its first sample, container delay dropped. A plain ``-ss start`` only
    agrees with that when ``start`` is below the delay; past it, ffmpeg
    honors the delay and every clip ends up shifted by it. Seeking to
    ``start + delay`` is always in the honored regime and lands exactly on
    own-time ``start``, for any ``start``.
    """
    stream_index = spec.stream_index if spec.stream_index is not None else 0
    # -ss is relative to the file's own start, i.e. the earliest stream.
    delay = max(0.0, probe_stream_start_time(spec.path, stream_index) - _probe_format_start_time(spec.path))
    return ["-ss", f"{start + delay:.6f}"]


def _probe_format_start_time(path: str) -> float:
    match = _DURATION_START_RE.search(_ffmpeg_info(path))
    return float(match["start"]) if match else 0.0


def _list_subtitle_streams(path: str) -> list[re.Match[str]]:
    return [m for line in _ffmpeg_info(path).splitlines() if (m := _SUBTITLE_STREAM_RE.match(line))]


def probe_subtitle_codec(path: str, index: int) -> str:
    """Return the codec name (e.g. ``subrip``, ``ass``) of subtitle stream ``index`` in ``path``."""
    subtitle_streams = _list_subtitle_streams(path)
    if index >= len(subtitle_streams):
        raise FFmpegError(
            tr(
                "Piste de sous-titres @{index} absente de {path!r} ({count} trouvée(s)).",
                index=index,
                path=path,
                count=len(subtitle_streams),
            )
        )
    return subtitle_streams[index]["codec"]


_ANY_STREAM_RE = re.compile(r"^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\((?P<lang>[^)]+)\))?:\s*(?P<kind>\w+):")
_TITLE_TAG_RE = re.compile(r"^\s+title\s*: (?P<title>.*)$")


def probe_stream_tags(path: str, kind: str) -> list[dict[str, str]]:
    """``language``/``title`` tags of every ``kind`` stream (``"Audio"``,
    ``"Subtitle"``...), indexed like ffmpeg's ``0:a:N``/``0:s:N`` selectors."""
    tags: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in _ffmpeg_info(path).splitlines():
        if stream := _ANY_STREAM_RE.match(line):
            current = None
            if stream["kind"] == kind:
                current = {"language": stream["lang"]} if stream["lang"] else {}
                tags.append(current)
        elif current is not None and (title := _TITLE_TAG_RE.match(line)):
            current.setdefault("title", title["title"])
    return tags


_FORCED_TITLE_RE = re.compile(r"forc", re.IGNORECASE)


def probe_subtitle_streams(path: str) -> list[SubtitleStreamInfo]:
    """List the subtitle streams of a media file, indexed like ffmpeg's ``0:s:N``."""
    tags = probe_stream_tags(path, "Subtitle")
    streams: list[SubtitleStreamInfo] = []
    for match in _list_subtitle_streams(path):
        line = match.string
        tag = tags[len(streams)] if len(streams) < len(tags) else {}
        title = tag.get("title")
        streams.append(
            SubtitleStreamInfo(
                index=len(streams),
                codec=match["codec"],
                language=tag.get("language"),
                title=title,
                forced="(forced)" in line or bool(title and _FORCED_TITLE_RE.search(title)),
                default="(default)" in line,
            )
        )
    return streams


def probe_subtitle_count(path: str) -> int:
    """Return how many subtitle streams ``path`` has."""
    return len(_list_subtitle_streams(path))


_CHANNEL_LAYOUTS = {
    "mono": 1,
    "stereo": 2,
    "2.1": 3,
    "5.1": 6,
    "5.1(side)": 6,
    "7.1": 8,
}


def extract_pcm(
    spec: AudioTrackSpec,
    sample_rate: int = 16000,
    start: float | None = None,
    duration: float | None = None,
) -> np.ndarray:
    """Decode a track to mono float32 PCM in [-1, 1] at ``sample_rate`` Hz.

    ``start``/``duration`` (seconds) restrict decoding to a window of the
    track: ``-ss`` is placed *before* ``-i`` so ffmpeg seeks directly to that
    point instead of decoding everything up to it, which is what makes
    windowed extraction actually fast on long files.
    """
    ffmpeg = resolve_ffmpeg()
    stream_index = spec.stream_index if spec.stream_index is not None else 0
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    if start is not None:
        cmd += _seek_args(spec, start)
    cmd += ["-i", spec.path]
    if duration is not None:
        cmd += ["-t", str(duration)]
    cmd += [
        "-map",
        f"0:a:{stream_index}",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-",
    ]
    proc = _run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(
            tr(
                "Échec de l'extraction audio pour {track!r} :\n{details}",
                track=spec.raw,
                details=proc.stderr.decode(errors="replace"),
            )
        )
    return _pcm_from_s16le(np.frombuffer(proc.stdout, dtype="<i2"))


def _pcm_from_s16le(samples: np.ndarray) -> np.ndarray:
    return samples.astype(np.float32) / 32768.0


def decode_tracks_to_files(path: str, stream_indices: list[int], sample_rate: int, out_dir: Path) -> list[Path]:
    """Decode several whole audio tracks of one file in a single ffmpeg pass.

    Same samples as one ``extract_pcm(..., start=None, duration=None)`` per
    track (verified bit for bit), but the file is read and demuxed once
    instead of once per track -- for a multi-GB remux with several dubs,
    that read is most of the decoding time. Outputs go to raw s16le files
    (load them with ``load_pcm_file``) rather than pipes, so the caller can
    hold one track in memory at a time.
    """
    cmd = [resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", path]
    outputs = []
    for idx in stream_indices:
        out = out_dir / f"track{idx}.s16le"
        cmd += ["-map", f"0:a:{idx}", "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-acodec", "pcm_s16le", str(out)]
        outputs.append(out)
    proc = _run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(
            tr(
                "Échec de l'extraction audio pour {track!r} :\n{details}",
                track=path,
                details=proc.stderr.decode(errors="replace"),
            )
        )
    return outputs


def load_pcm_file(path: Path) -> np.ndarray:
    """Load a ``decode_tracks_to_files`` output exactly as ``extract_pcm`` returns it."""
    return _pcm_from_s16le(np.fromfile(path, dtype="<i2"))


_PEAKS_SAMPLE_RATE = 22050


def extract_peaks(
    spec: AudioTrackSpec, buckets: int, start: float = 0.0, duration: float | None = None
) -> tuple[np.ndarray, np.ndarray, float]:
    """Per-bucket (min, max) amplitude envelope of a track window, for drawing a waveform.

    Returns ``(mins, maxes, actual_duration)`` -- ``actual_duration`` is the
    real decoded length, which can be shorter than requested ``duration``
    near a track's end. Downsampling to ``buckets`` happens here, not in the
    browser: decoding is cheap (this is plain ffmpeg PCM extraction, not the
    STFT/HPSS analysis path -- confirmed even a whole 6-minute track decodes
    in well under a second), but shipping raw samples over HTTP for a
    multi-minute track would not be. A whole-track call (``duration=None``)
    is how the GUI learns a track's total duration in the first place.
    """
    pcm = extract_pcm(spec, sample_rate=_PEAKS_SAMPLE_RATE, start=start or None, duration=duration)
    actual_duration = len(pcm) / _PEAKS_SAMPLE_RATE
    if len(pcm) == 0 or buckets <= 0:
        return np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32), actual_duration

    bucket_size = max(1, len(pcm) // buckets)
    usable = pcm[: bucket_size * buckets] if len(pcm) >= bucket_size * buckets else pcm
    n = len(usable) // bucket_size
    if n == 0:
        return np.array([pcm.min()], dtype=np.float32), np.array([pcm.max()], dtype=np.float32), actual_duration
    chunks = usable[: n * bucket_size].reshape(n, bucket_size)
    return chunks.min(axis=1), chunks.max(axis=1), actual_duration


def extract_wav_clip(spec: AudioTrackSpec, start: float, duration: float, sample_rate: int = 44100) -> bytes:
    """Encode a short window of a track as playable WAV bytes.

    Unlike ``extract_pcm`` (mono, 16kHz, raw samples only ever consumed by
    numpy for analysis), this keeps the track's original channel layout at a
    normal playback rate and wraps it in a proper WAV header -- for the
    GUI's listen-before-render preview, not analysis. Only ever called with
    a short ``duration`` (a preview clip, not a whole track), so this stays
    fast even without the analysis cache.
    """
    ffmpeg = resolve_ffmpeg()
    stream_index = spec.stream_index if spec.stream_index is not None else 0
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        *_seek_args(spec, start), "-i", spec.path, "-t", str(duration),
        "-map", f"0:a:{stream_index}",
        "-ar", str(sample_rate),
        "-f", "wav", "-acodec", "pcm_s16le", "-",
    ]
    proc = _run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(
            tr(
                "Échec de l'extraction du clip pour {track!r} :\n{details}",
                track=spec.raw,
                details=proc.stderr.decode(errors="replace"),
            )
        )
    return proc.stdout
