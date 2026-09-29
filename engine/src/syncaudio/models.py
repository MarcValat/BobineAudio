from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AudioTrackSpec:
    """A reference to a single audio track, parsed from a CLI argument.

    ``raw`` is the original CLI string (used for display). ``path`` is the
    media file on disk. ``stream_index`` selects which audio stream to use
    when the file contains more than one (e.g. a multi-language mkv); ``None``
    means "the only one, or the first one".
    """

    raw: str
    path: str
    stream_index: int | None = None

    @property
    def label(self) -> str:
        return self.raw


@dataclass(frozen=True)
class SubtitleStreamInfo:
    """One subtitle stream reported by ffmpeg for a container file."""

    index: int  # among subtitle streams only, like ffmpeg's 0:s:N
    codec: str
    language: str | None
    title: str | None
    # Forced subtitles (only the lines the audio doesn't cover: signs, a
    # foreign-language line...), by disposition or, as many files only say
    # it there, by title.
    forced: bool
    default: bool


@dataclass(frozen=True)
class AudioStreamInfo:
    """One audio stream reported by ffmpeg for a container file."""

    index: int
    codec: str | None
    language: str | None
    channels: int | None = None
    sample_rate: int | None = None
    # In bits/sec, when ffmpeg's probe reports one -- common for MP4-sourced
    # tracks (their container stores it directly), rare for MKV (usually
    # None there, since Matroska doesn't carry a bitrate field ffmpeg can
    # read without actually decoding).
    bit_rate: int | None = None


@dataclass(frozen=True)
class AlignmentResult:
    """Result of aligning one candidate track against the reference track."""

    track: AudioTrackSpec
    offset_seconds: float
    confidence: float
    ambiguous: bool
