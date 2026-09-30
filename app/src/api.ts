import { t } from "./i18n";
// Client for the syncaudio FastAPI sidecar (engine/src/syncaudio/server.py).
// Dev-time only: the sidecar is spawned by src-tauri/src/lib.rs via `uv run`.
// Phase 6 packaging will need this base URL/port to stay in sync with
// whatever bundled sidecar binary replaces that dev-time spawn.
const BASE_URL = "http://127.0.0.1:8756";

export interface TrackInfo {
  index: number;
  codec: string | null;
  language: string | null;
  channels: number | null;
  sample_rate: number | null;
  // Container-level presentation delay (e.g. from mkvtoolnix's --sync), if
  // any -- display-only, see the engine's probe_stream_start_time docstring
  // for why detection/render intentionally ignore it.
  start_time: number;
}

export interface SubtitleInfo {
  index: number; // among the file's subtitle tracks
  codec: string;
  language: string | null;
  title: string | null;
  forced: boolean;
  // Text subtitles (srt, ass/ssa) can be retimed along with their audio;
  // image ones (PGS, VobSub) can't.
  shiftable: boolean;
}

export interface ProbeResponse {
  path: string;
  tracks: TrackInfo[];
  subtitles: SubtitleInfo[];
}

export interface SegmentOut {
  start_s: number;
  end_s: number;
  offset_start: number;
  offset_end: number;
  is_drift: boolean;
  confidence: number;
}

export interface SegmentsResponse {
  reference: string;
  track: string;
  segments: SegmentOut[];
}

export interface RenderedTrack {
  track: string;
  language: string | null;
  offset_seconds: number | null; // null for a segmented (non-constant) correction
  segments: SegmentOut[] | null;
}

export interface RenderResponse {
  written: string[];
  corrections: RenderedTrack[];
}

async function readErrorDetail(resp: Response): Promise<string> {
  try {
    const body = await resp.json();
    return body.detail ?? t().common.httpError(resp.status);
  } catch {
    return t().common.httpError(resp.status);
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function probe(path: string): Promise<ProbeResponse> {
  const resp = await fetch(`${BASE_URL}/probe?path=${encodeURIComponent(path)}`);
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return resp.json();
}

/** The language of the engine's messages (job logs, errors). */
export async function setEngineLanguage(language: string): Promise<void> {
  const resp = await fetch(`${BASE_URL}/language`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
}

/** Which of `paths` already exist, in order. */
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (paths.length === 0) return [];
  const resp = await fetch(`${BASE_URL}/paths/exist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return (await resp.json()).exists;
}

/** The files dropped on the window (see the engine's /paths/expand): a
 * folder stands for its files with one of `extensions`, in name order. */
export async function expandPaths(paths: string[], extensions: string[]): Promise<string[]> {
  const resp = await fetch(`${BASE_URL}/paths/expand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, extensions }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return (await resp.json()).files;
}

export interface PrefetchResponse {
  cached: number;
}

/**
 * Warms the engine's analysis cache for every track in the background --
 * fire right after `probe` succeeds so that by the time the user picks a
 * reference and clicks a detection button, the ~7s-per-track
 * extraction+envelope cost (the actual bottleneck, not ffmpeg decoding) is
 * already paid. Fire-and-forget: a failure here just means the next
 * detection redoes the work itself, so callers aren't required to await
 * the job's completion or handle its errors specially.
 */
export async function startPrefetchJob(path: string, trackIndices: number[]): Promise<string> {
  const resp = await fetch(`${BASE_URL}/jobs/prefetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: trackIndices.map((index) => ({ path, index })) }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  const data = await resp.json();
  return data.job_id as string;
}

/**
 * A short playable WAV clip of one track, for the "listen before you
 * render" preview -- not the 16kHz analysis PCM, a normal-rate clip meant
 * to actually be played back in an <audio> element.
 */
export async function fetchClip(path: string, index: number, start: number, duration: number): Promise<Blob> {
  const params = new URLSearchParams({ path, index: String(index), start: String(start), duration: String(duration) });
  // no-store: this is re-fetched with a genuinely different `start` every
  // time the user seeks, and must never come back stale from the browser's
  // HTTP cache (the sidecar's plain Response doesn't set any cache headers
  // of its own to prevent that).
  const resp = await fetch(`${BASE_URL}/clip?${params.toString()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return resp.blob();
}

/**
 * What the render will produce for this track over [start, start +
 * duration) of the reference, given `segments` as currently edited -- the
 * engine builds it with the render's own filter, so jumps, blanks and drift
 * sound exactly as they will in the exported file.
 */
export async function fetchCorrectedClip(
  path: string,
  index: number,
  segments: SegmentOut[],
  start: number,
  duration: number,
): Promise<Blob> {
  const resp = await fetch(`${BASE_URL}/corrected-clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, index, segments, start, duration }),
    cache: "no-store",
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return resp.blob();
}

export interface WaveformResponse {
  duration: number;
  peaks_min: number[];
  peaks_max: number[];
}

/**
 * A downsampled (min, max) amplitude envelope for a track window -- never
 * ships raw audio, so it stays cheap even for a whole multi-minute track at
 * once (`duration` omitted), unlike `fetchClip`. Used to draw the
 * always-visible, zoomable comparison waveforms (see TrackPreview.tsx).
 */
export async function fetchWaveform(
  path: string,
  index: number,
  start: number,
  duration: number | null,
  buckets: number,
): Promise<WaveformResponse> {
  const params = new URLSearchParams({ path, index: String(index), start: String(start), buckets: String(buckets) });
  if (duration !== null) params.set("duration", String(duration));
  const resp = await fetch(`${BASE_URL}/waveform?${params.toString()}`);
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  return resp.json();
}

export async function startSegmentsJob(
  referencePath: string,
  referenceIndex: number,
  trackPath: string,
  trackIndex: number,
  options?: { windowS?: number; hopS?: number; marginS?: number },
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/jobs/segments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reference: { path: referencePath, index: referenceIndex },
      track: { path: trackPath, index: trackIndex },
      ...(options?.windowS !== undefined ? { window_s: options.windowS } : {}),
      ...(options?.hopS !== undefined ? { hop_s: options.hopS } : {}),
      ...(options?.marginS !== undefined ? { margin_s: options.marginS } : {}),
    }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  const data = await resp.json();
  return data.job_id as string;
}

export interface TrackSegments {
  trackIndex: number;
  segments: SegmentOut[];
  /** Tag the corrected track with this language instead of its own. */
  language?: string | null;
  /** Subtitle tracks of the same file timed on this audio: retimed with it,
   * segment by segment. */
  subtitles?: number[];
}

/**
 * Segmented (drift/jump-aware) render of `tracks` into one file at
 * `outputPath`, using each track's `segments` as-is instead of letting the
 * server re-run detection -- so a render after "Analyser" + manual edits in
 * SegmentEditor produces what was actually reviewed, not a silently
 * recomputed result that discards the edits. The file holds the video, the
 * reference track, these corrected tracks and the subtitles.
 */
export async function startSegmentedRenderJob(
  inputPath: string,
  referenceIndex: number,
  tracks: TrackSegments[],
  outputPath: string,
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/jobs/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input_path: inputPath,
      reference_index: referenceIndex,
      track_indices: tracks.map((t) => t.trackIndex),
      output_path: outputPath,
      segmented: true,
      segment_overrides: tracks.map((t) => ({
        track: { path: inputPath, index: t.trackIndex },
        segments: t.segments,
        language: t.language ?? null,
      })),
      subs: tracks.flatMap((t) =>
        (t.subtitles ?? []).map((index) => ({
          subs: { path: inputPath, index },
          audio: { path: inputPath, index: t.trackIndex },
        })),
      ),
    }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  const data = await resp.json();
  return data.job_id as string;
}

/**
 * Segmented render pulling the corrected track from a *different* file than
 * the reference (batch mode's case: reference and to-correct files are two
 * separate imports, never the same file@index pair `startSegmentedRenderJob`
 * assumes) -- `input_path` supplies the video/reference/subtitles as-is,
 * `only_imports` keeps it from also (redundantly) "correcting" any of its
 * own native tracks, and the corrected track is imported from `candidatePath`
 * as a donor, same mechanism as the CLI's `--import-audio`.
 */
export async function startCrossFileSegmentedRenderJob(
  referencePath: string,
  referenceIndex: number,
  candidatePath: string,
  candidateIndex: number,
  segments: SegmentOut[],
  options: { outputPath?: string; language?: string | null; subtitles?: number[] } = {},
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/jobs/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input_path: referencePath,
      reference_index: referenceIndex,
      only_imports: true,
      import_audio: [{ path: candidatePath, index: candidateIndex }],
      output_path: options.outputPath ?? null,
      segmented: true,
      segment_overrides: [
        { track: { path: candidatePath, index: candidateIndex }, segments, language: options.language ?? null },
      ],
      // The candidate file's own subtitles timed on its audio, imported and
      // retimed along with it.
      subs: (options.subtitles ?? []).map((index) => ({
        subs: { path: candidatePath, index },
        audio: { path: candidatePath, index: candidateIndex },
      })),
    }),
  });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
  const data = await resp.json();
  return data.job_id as string;
}

export type JobEvent<TResult> =
  | { type: "log"; message: string }
  | { type: "done"; result: TResult }
  | { type: "error"; message: string }
  | { type: "cancelled" };

/** Stop a running job (an export started too early...): the engine kills
 * its ffmpeg run, removes a half-written file, and the job's WebSocket
 * ends with a "cancelled" event. */
export async function cancelJob(jobId: string): Promise<void> {
  const resp = await fetch(`${BASE_URL}/jobs/${jobId}/cancel`, { method: "POST" });
  if (!resp.ok) throw new Error(await readErrorDetail(resp));
}

/**
 * Connects to a job's progress WebSocket; returns a function to close it early.
 *
 * Guards against the sidecar dying (or any other reason the socket just
 * closes) mid-job without ever sending a "done"/"error" event -- without
 * this, the caller's UI would stay stuck in "in progress" forever with no
 * way to know something went wrong.
 */
export function connectJobWS<TResult>(jobId: string, onEvent: (event: JobEvent<TResult>) => void): () => void {
  const ws = new WebSocket(`ws://127.0.0.1:8756/jobs/${jobId}/ws`);
  let settled = false;

  ws.onmessage = (ev) => {
    const event: JobEvent<TResult> = JSON.parse(ev.data);
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") settled = true;
    onEvent(event);
  };
  ws.onerror = () => {
    if (!settled) {
      settled = true;
      onEvent({ type: "error", message: t().common.websocketLost });
    }
  };
  ws.onclose = () => {
    if (!settled) {
      settled = true;
      onEvent({ type: "error", message: t().common.connectionLost });
    }
  };
  return () => ws.close();
}
