"""FastAPI sidecar exposing the engine over HTTP.

Thin layer over the same functions the CLI uses (``render.py``,
``segments.py``, ``ffmpeg_backend.py``) -- the CLI remains a perfectly valid
client on its own; this is an additional one for the future GUI.

Quick requests (probe, clips, waveforms) answer directly. Detection and
render run as jobs (``POST /jobs/segments``, ``POST /jobs/render``, plus
``POST /jobs/prefetch``): they return a ``job_id`` immediately, run in a
background thread, and ``WS /jobs/{job_id}/ws`` streams the same progress
messages the CLI prints ("[analyse] ...") as they happen, ending with the
result -- they take tens of seconds on a real file, so the GUI shows live
progress instead of a frozen spinner.
"""

from __future__ import annotations

import asyncio
import re
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from syncaudio import analysis_cache, dsp, waveform_cache
from syncaudio.cancellation import Cancelled
from syncaudio.analysis_cache import ANALYSIS_SAMPLE_RATE
from syncaudio.ffmpeg_backend import (
    FFmpegError,
    extract_wav_clip,
    probe_audio_streams,
    probe_stream_start_time,
    probe_subtitle_streams,
)
from syncaudio.i18n import LANGUAGES, set_language, tr
from syncaudio.jobs import get_job, start_job
from syncaudio.models import AudioTrackSpec
from syncaudio.render import (
    SegmentedTrackCorrection,
    TrackCorrection,
    check_import_track,
    corrected_clip,
    default_output_path,
    plan_corrections,
    plan_segmented_correction,
    render as render_tracks,
    resolve_targets,
    track_key,
)
from syncaudio.segments import DEFAULT_HOP_S, DEFAULT_MARGIN_S, DEFAULT_WINDOW_S, Segment, detect_segments
from syncaudio.subtitles import is_shiftable

@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # The computation libraries load in the background once the server is
    # up: /health answers (and the app opens) right away, and they're ready
    # well before anyone has picked a file to analyze.
    threading.Thread(target=dsp.warm_up, name="syncaudio-warm-up", daemon=True).start()
    threading.Thread(target=analysis_cache.remove_legacy_cache, name="syncaudio-legacy-cache", daemon=True).start()
    yield


app = FastAPI(title="Bobine Audio", version="0.1.0", lifespan=_lifespan)

# The sidecar only ever binds to 127.0.0.1 (see `syncaudio serve`), so it's
# never reachable from outside the machine -- wide-open CORS here just lets
# the Tauri webview (a different origin: tauri://... or localhost:1420 in
# dev) call it, same as any other local desktop-app sidecar.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_NO_LOG: Callable[[str], None] = lambda _msg: None  # noqa: E731


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class TrackRef(BaseModel):
    """A single track, addressed like the CLI's ``chemin`` / ``chemin@INDEX``."""

    path: str
    index: int | None = None

    def to_spec(self) -> AudioTrackSpec:
        raw = f"{self.path}@{self.index}" if self.index is not None else self.path
        return AudioTrackSpec(raw=raw, path=self.path, stream_index=self.index)


@app.exception_handler(FFmpegError)
async def _ffmpeg_error(_request: Request, exc: FFmpegError) -> JSONResponse:
    """A file ffmpeg can't read (missing, not media, no such track...) is the
    request's fault: 400 with ffmpeg's explanation, from any route. Jobs
    report it as their error message (see jobs.py)."""
    return JSONResponse(status_code=400, content={"detail": str(exc)})


class JobStarted(BaseModel):
    job_id: str


@app.websocket("/jobs/{job_id}/ws")
async def job_ws(websocket: WebSocket, job_id: str) -> None:
    """Stream a job's progress messages as they happen, ending with its result, its error or its cancellation."""
    await websocket.accept()
    job = get_job(job_id)
    if job is None:
        await websocket.send_json({"type": "error", "message": f"Job inconnu : {job_id}"})
        await websocket.close()
        return

    since = 0
    try:
        while True:
            new_messages, since, status, result, error = job.snapshot(since)
            for message in new_messages:
                await websocket.send_json({"type": "log", "message": message})
            if status != "running":
                if status == "done":
                    await websocket.send_json({"type": "done", "result": result})
                elif status == "cancelled":
                    await websocket.send_json({"type": "cancelled"})
                else:
                    await websocket.send_json({"type": "error", "message": error})
                break
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return
    await websocket.close()


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, bool]:
    """Stop a running job (an export started too early...): its ffmpeg run is
    killed and it ends as "cancelled", leaving no half-written file behind."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(404, tr("Job inconnu : {job_id}", job_id=job_id))
    job.cancel()
    return {"cancelled": True}


class PathsRequest(BaseModel):
    paths: list[str]


class PathsExistResponse(BaseModel):
    exists: list[bool]


@app.post("/paths/exist", response_model=PathsExistResponse)
def paths_exist(req: PathsRequest) -> PathsExistResponse:
    """Which of these paths are already taken, in order: the GUI names a
    batch export after its original only where that overwrites nothing."""
    return PathsExistResponse(exists=[Path(p).exists() for p in req.paths])


class CacheResponse(BaseModel):
    bytes: int


@app.get("/cache", response_model=CacheResponse)
def cache_size() -> CacheResponse:
    """How much disk the analysis cache takes."""
    return CacheResponse(bytes=analysis_cache.disk_usage())


@app.delete("/cache", response_model=CacheResponse)
def cache_clear() -> CacheResponse:
    """Empties the analysis cache (Options); answers what's left."""
    analysis_cache.clear_disk()
    waveform_cache.clear()
    return CacheResponse(bytes=analysis_cache.disk_usage())


class LanguageRequest(BaseModel):
    language: str


@app.post("/language", status_code=204)
def language(req: LanguageRequest) -> Response:
    """The language of the messages the GUI shows (job logs, errors): it
    sends its own at startup and whenever the user changes it."""
    if req.language not in LANGUAGES:
        raise HTTPException(400, f"Unknown language: {req.language!r}")
    set_language(req.language)
    return Response(status_code=204)


class ExpandPathsRequest(BaseModel):
    paths: list[str]
    # Lowercase, without the dot: what a folder's files are kept by.
    extensions: list[str]


class ExpandPathsResponse(BaseModel):
    files: list[str]


def _natural_key(name: str) -> list[int | str]:
    """Sorts "Episode 2" before "Episode 10"."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name.lower())]


@app.post("/paths/expand", response_model=ExpandPathsResponse)
def expand_paths(req: ExpandPathsRequest) -> ExpandPathsResponse:
    """The files dropped on the GUI, in order: a file as is, a folder as the
    files directly in it with one of `extensions`, sorted by name (a series
    folder in episode order). Paths that no longer exist are left out."""
    extensions = {e.lower() for e in req.extensions}
    files: list[str] = []
    for p in map(Path, req.paths):
        if p.is_dir():
            inside = [f for f in p.iterdir() if f.is_file() and f.suffix[1:].lower() in extensions]
            files.extend(str(f) for f in sorted(inside, key=lambda f: _natural_key(f.name)))
        elif p.is_file():
            files.append(str(p))
    return ExpandPathsResponse(files=files)


class TrackInfo(BaseModel):
    index: int
    codec: str | None
    language: str | None
    # Its name in the container, if any: shown on hover in the tracks tables.
    title: str | None = None
    channels: int | None
    sample_rate: int | None
    # Container-level presentation delay (e.g. from mkvtoolnix's --sync), if
    # any -- display-only: every extraction works on the track's own
    # timeline with this delay excluded (see ffmpeg_backend._seek_args), so
    # the GUI uses it only to show the residual offset a normal player,
    # which does apply it, would see.
    start_time: float


class SubtitleInfo(BaseModel):
    index: int  # among the file's subtitle tracks
    codec: str
    language: str | None
    title: str | None
    forced: bool
    # Text subtitles (srt, ass/ssa) can be retimed segment by segment along
    # with their audio; image ones (PGS, VobSub) can't.
    shiftable: bool


class ProbeResponse(BaseModel):
    path: str
    tracks: list[TrackInfo]
    subtitles: list[SubtitleInfo] = []


@app.get("/probe", response_model=ProbeResponse)
def probe(path: str) -> ProbeResponse:
    streams = probe_audio_streams(path)
    return ProbeResponse(
        path=path,
        tracks=[
            TrackInfo(
                index=s.index,
                codec=s.codec,
                language=s.language,
                title=s.title,
                channels=s.channels,
                sample_rate=s.sample_rate,
                start_time=probe_stream_start_time(path, s.index),
            )
            for s in streams
        ],
        subtitles=[
            SubtitleInfo(
                index=s.index,
                codec=s.codec,
                language=s.language,
                title=s.title,
                forced=s.forced,
                shiftable=is_shiftable(s.codec),
            )
            for s in probe_subtitle_streams(path)
        ],
    )


_MAX_CLIP_DURATION_S = 30.0


@app.get("/clip")
def clip(path: str, index: int, start: float = 0.0, duration: float = 12.0) -> Response:
    """A short playable WAV clip of one track, for the GUI's listen-before-render preview.

    Synchronous (not a job): unlike a full-track analysis, extracting a
    short window is fast enough (ffmpeg seeks straight to ``start`` instead
    of decoding everything before it) that a progress stream would be
    pointless overhead here.
    """
    spec = AudioTrackSpec(raw=f"{path}@{index}", path=path, stream_index=index)
    wav_bytes = extract_wav_clip(spec, start=max(0.0, start), duration=min(duration, _MAX_CLIP_DURATION_S))
    return Response(content=wav_bytes, media_type="audio/wav")


class WaveformResponse(BaseModel):
    duration: float
    peaks_min: list[float]
    peaks_max: list[float]


@app.get("/waveform", response_model=WaveformResponse)
def waveform(path: str, index: int, start: float = 0.0, duration: float | None = None, buckets: int = 800) -> WaveformResponse:
    """Downsampled (min, max) waveform envelope for a track window, for the GUI's
    always-visible, zoomable comparison view (see TrackPreview.tsx/Waveform.tsx).

    Unlike ``/clip``, this never ships audio samples -- just ``buckets`` pairs
    of floats -- so it stays cheap even for a whole multi-minute track at
    once (``duration`` omitted), which is how the GUI learns a track's total
    duration for its initial, fully-zoomed-out view.
    """
    spec = AudioTrackSpec(raw=f"{path}@{index}", path=path, stream_index=index)
    mins, maxes, actual_duration = waveform_cache.get_peaks(spec, buckets, start=max(0.0, start), duration=duration)
    # 4 decimals of full scale are far below a pixel, and halve the JSON of
    # the GUI's whole-track fetch (over a hundred thousand buckets). float64
    # first: a rounded float32 still prints with float32's noise digits.
    return WaveformResponse(
        duration=actual_duration,
        peaks_min=np.round(mins.astype(np.float64), 4).tolist(),
        peaks_max=np.round(maxes.astype(np.float64), 4).tolist(),
    )


class PrefetchRequest(BaseModel):
    tracks: list[TrackRef]
    start: float = 0.0
    duration: float | None = None


class PrefetchResponse(BaseModel):
    cached: int


def _do_prefetch(req: PrefetchRequest, log: Callable[[str], None] = lambda _msg: None) -> PrefetchResponse:
    analysis_cache.prefetch([ref.to_spec() for ref in req.tracks], ANALYSIS_SAMPLE_RATE, req.start, req.duration, log=log)
    return PrefetchResponse(cached=len(req.tracks))


@app.post("/jobs/prefetch", response_model=JobStarted)
def start_prefetch_job(req: PrefetchRequest) -> JobStarted:
    """Warm the analysis cache for every listed track in the background.

    Meant to be fired (and forgotten -- errors here are non-fatal, a later
    align/segments/render call will just redo the work) right after
    `/probe` succeeds, so that by the time the user picks a reference and
    clicks a detection button, the ~7s-per-track extraction+envelope cost
    (see analysis_cache.py) is already paid.
    """
    job = start_job(lambda log: _do_prefetch(req, log).model_dump())
    return JobStarted(job_id=job.id)


class SegmentsRequest(BaseModel):
    reference: TrackRef
    track: TrackRef
    start: float = 0.0
    duration: float | None = None
    window_s: float = DEFAULT_WINDOW_S
    hop_s: float = DEFAULT_HOP_S
    margin_s: float = DEFAULT_MARGIN_S


class SegmentOut(BaseModel):
    start_s: float
    end_s: float
    offset_start: float
    offset_end: float
    is_drift: bool
    # Defaulted to 1.0 (not 0.0): a segment reaching this API without an
    # explicit confidence is one the GUI itself constructed (a manual edit
    # sent back for render) rather than one the detector produced -- treat a
    # human-reviewed value as fully trusted, not as if it were unsupported.
    confidence: float = 1.0

    @staticmethod
    def from_segment(seg: Segment) -> SegmentOut:
        return SegmentOut(
            start_s=seg.start_s, end_s=seg.end_s, offset_start=seg.offset_start, offset_end=seg.offset_end,
            is_drift=seg.is_drift, confidence=seg.confidence,
        )

    def to_segment(self) -> Segment:
        return Segment(
            start_s=self.start_s, end_s=self.end_s, offset_start=self.offset_start, offset_end=self.offset_end,
            confidence=self.confidence,
        )


class SegmentsResponse(BaseModel):
    reference: str
    track: str
    segments: list[SegmentOut]


class CorrectedClipRequest(BaseModel):
    path: str
    index: int
    segments: list[SegmentOut]
    start: float = 0.0
    duration: float = 12.0


@app.post("/corrected-clip")
def corrected_clip_endpoint(req: CorrectedClipRequest) -> Response:
    """The GUI's "Résultat final" preview: a short WAV of exactly what the
    render will produce for this track over [start, start + duration) of the
    reference, given the segments as currently edited -- same filter as the
    render itself (see render.corrected_clip), so jumps, blanks and drift
    are heard the way they'll end up in the file."""
    spec = AudioTrackSpec(raw=f"{req.path}@{req.index}", path=req.path, stream_index=req.index)
    try:
        wav_bytes = corrected_clip(
            spec,
            [s.to_segment() for s in req.segments],
            start=max(0.0, req.start),
            duration=min(req.duration, _MAX_CLIP_DURATION_S),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(content=wav_bytes, media_type="audio/wav")


def _do_segments(req: SegmentsRequest, log: Callable[[str], None] = _NO_LOG) -> SegmentsResponse:
    segs = detect_segments(
        req.reference.to_spec(),
        req.track.to_spec(),
        start=req.start,
        duration=req.duration,
        window_s=req.window_s,
        hop_s=req.hop_s,
        margin_s=req.margin_s,
        log=log,
    )
    return SegmentsResponse(
        reference=req.reference.to_spec().raw,
        track=req.track.to_spec().raw,
        segments=[SegmentOut.from_segment(s) for s in segs],
    )


@app.post("/jobs/segments", response_model=JobStarted)
def start_segments_job(req: SegmentsRequest) -> JobStarted:
    job = start_job(lambda log: _do_segments(req, log).model_dump())
    return JobStarted(job_id=job.id)


class SubsPair(BaseModel):
    subs: TrackRef
    audio: TrackRef


class SegmentOverride(BaseModel):
    """Segments to use for a candidate as-is, skipping ``detect_segments`` for it.

    Lets a caller that already ran ``/jobs/segments`` and let the user
    manually edit the result (drag boundaries, merge segments, ...) render
    exactly what was reviewed, instead of the server silently redoing its
    own detection and discarding the edits.
    """

    track: TrackRef
    segments: list[SegmentOut]
    # Language to tag the corrected track with instead of its own -- for a
    # track that has none (a bare .wav, .flac...) or a wrong one.
    language: str | None = None


class RenderRequest(BaseModel):
    input_path: str
    reference_index: int
    track_indices: list[int] | None = None
    only_imports: bool = False
    import_audio: list[TrackRef] = []
    subs: list[SubsPair] = []
    output_path: str | None = None
    audio_only: bool = False
    segmented: bool = False
    segment_overrides: list[SegmentOverride] = []
    window_s: float = DEFAULT_WINDOW_S
    hop_s: float = DEFAULT_HOP_S
    margin_s: float = DEFAULT_MARGIN_S
    start: float = 0.0
    duration: float | None = None


class RenderedTrack(BaseModel):
    track: str
    language: str | None
    offset_seconds: float | None = None  # None for a segmented (non-constant) correction
    segments: list[SegmentOut] | None = None


class RenderResponse(BaseModel):
    written: list[str]
    corrections: list[RenderedTrack]


def _do_render(req: RenderRequest, log: Callable[[str], None] = _NO_LOG) -> RenderResponse:
    # Runs as a job: a ValueError from these checks becomes its error message.
    if req.only_imports and req.track_indices:
        raise ValueError(tr("only_imports et track_indices sont incompatibles."))
    targets = resolve_targets(req.input_path, req.reference_index, req.track_indices, req.only_imports)
    for ref in req.import_audio:
        check_import_track(ref.to_spec())

    reference_spec = AudioTrackSpec(raw=f"{req.input_path}@{req.reference_index}", path=req.input_path, stream_index=req.reference_index)
    same_file_specs = [AudioTrackSpec(raw=f"{req.input_path}@{i}", path=req.input_path, stream_index=i) for i in targets]
    import_audio_specs = [ref.to_spec() for ref in req.import_audio]
    candidates = same_file_specs + import_audio_specs
    candidate_keys = [track_key(c) for c in candidates]

    subs_positions: list[int] = []
    for pair in req.subs:
        key = track_key(pair.audio.to_spec())
        if key not in candidate_keys:
            raise HTTPException(
                400,
                tr(
                    "subs {subs} : la piste audio indiquée ne correspond à aucune piste corrigée "
                    "(track_indices ou import_audio, même fichier@index).",
                    subs=f"{pair.subs.path}@{pair.subs.index}",
                ),
            )
        subs_positions.append(candidate_keys.index(key))

    output_path = req.output_path if req.output_path is not None else default_output_path(req.input_path)

    try:
        if req.segmented:
            overrides = {track_key(o.track.to_spec()): o for o in req.segment_overrides}
            seg_corrections: list[SegmentedTrackCorrection] = []
            for spec in candidates:
                override = overrides.get(track_key(spec))
                if override is not None:
                    language = override.language
                    if language is None:
                        idx = spec.stream_index if spec.stream_index is not None else 0
                        streams = {s.index: s for s in probe_audio_streams(spec.path)}
                        language = streams[idx].language if idx in streams else None
                    log(tr("[segments] {track} : utilisation des segments fournis (édités manuellement)", track=spec.raw))
                    seg_corrections.append(
                        SegmentedTrackCorrection(
                            track=spec, language=language, segments=[s.to_segment() for s in override.segments]
                        )
                    )
                else:
                    seg_corrections.append(
                        plan_segmented_correction(
                            reference_spec, spec, start=req.start, duration=req.duration,
                            window_s=req.window_s, hop_s=req.hop_s, margin_s=req.margin_s, log=log,
                        )
                    )
            segmented_imported_subs = [
                (pair.subs.to_spec(), seg_corrections[pos].segments) for pair, pos in zip(req.subs, subs_positions)
            ]
            log(tr("[rendu] écriture de {path} ...", path=output_path))
            written = render_tracks(
                req.input_path, req.reference_index, corrections=[], output_path=output_path,
                audio_only=req.audio_only, segmented_corrections=seg_corrections,
                segmented_imported_subs=segmented_imported_subs,
            )
            corrections_out = [
                RenderedTrack(track=sc.track.raw, language=sc.language, segments=[SegmentOut.from_segment(s) for s in sc.segments])
                for sc in seg_corrections
            ]
        else:
            corrections: list[TrackCorrection] = plan_corrections(
                reference_spec, candidates, start=req.start, duration=req.duration, log=log
            )
            imported_subs = [(pair.subs.to_spec(), corrections[pos].offset_seconds) for pair, pos in zip(req.subs, subs_positions)]
            log(tr("[rendu] écriture de {path} ...", path=output_path))
            written = render_tracks(
                req.input_path, req.reference_index, corrections, output_path,
                audio_only=req.audio_only, imported_subs=imported_subs,
            )
            corrections_out = [
                RenderedTrack(track=c.track.raw, language=c.language, offset_seconds=c.offset_seconds) for c in corrections
            ]
    except Cancelled:
        # Stopped midway: what's on disk is a truncated, unplayable file.
        Path(output_path).unlink(missing_ok=True)
        raise

    return RenderResponse(written=written, corrections=corrections_out)


@app.post("/jobs/render", response_model=JobStarted)
def start_render_job(req: RenderRequest) -> JobStarted:
    job = start_job(lambda log: _do_render(req, log).model_dump())
    return JobStarted(job_id=job.id)
