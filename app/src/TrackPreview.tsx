import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fetchClip, fetchCorrectedClip, fetchWaveform, type SegmentOut } from "./api";
import { candidateSpansIn, planResult, silentRegions, skippedRegions } from "./resultPlan";
import { formatTime } from "./SegmentChart";
import { Waveform, type HighlightRegion } from "./Waveform";
import { WaveformNavigator } from "./WaveformNavigator";

const PREVIEW_DURATION_S = 12;
const WAVEFORM_BUCKETS = 800;
// Below this, there's nothing more to see: the panel isn't wide enough for
// finer detail to matter, and the diff highlight is computed analytically
// anyway, not read off the waveform pixel by pixel.
const MIN_VIEW_DURATION_S = 20;
// Fetched once per track, whole-file, so every zoom/pan afterwards is a pure
// client-side resample (see resamplePeaks) instead of a network round trip.
// At this bucket count a typical (5-45min) episode stays comfortably sharp
// down to the MIN_VIEW_DURATION_S floor above.
const FULL_TRACK_BUCKETS = 20000;

/**
 * The reference-time offset applying at `t`, per the current segments
 * (linearly interpolated across a drift segment, clamped to the first/last
 * segment's edge offset outside the analyzed range). Used to pick where in
 * the candidate track a given reference moment actually is.
 */
function offsetAt(segments: SegmentOut[], t: number): number {
  if (segments.length === 0) return 0;
  if (t <= segments[0].start_s) return segments[0].offset_start;
  const last = segments[segments.length - 1];
  if (t >= last.end_s) return last.offset_end;
  for (const seg of segments) {
    if (t >= seg.start_s && t <= seg.end_s) {
      if (seg.end_s <= seg.start_s) return seg.offset_start;
      const frac = (t - seg.start_s) / (seg.end_s - seg.start_s);
      return seg.offset_start + frac * (seg.offset_end - seg.offset_start);
    }
  }
  return 0;
}

interface PeaksData {
  min: number[];
  max: number[];
  dataStart: number;
  dataEnd: number;
}

interface FullPeaks {
  min: number[];
  max: number[];
}

/** Min/max of the whole-track peaks over time range [t0, t1). */
function peakRange(full: FullPeaks, fullDuration: number, t0: number, t1: number): [number, number] | null {
  const n = full.min.length;
  if (n === 0 || fullDuration <= 0 || t1 <= t0) return null;
  const bucket = fullDuration / n;
  const lo = Math.max(0, Math.min(n - 1, Math.floor(t0 / bucket)));
  const hi = Math.max(lo + 1, Math.min(n, Math.ceil(t1 / bucket)));
  let mn = full.min[lo];
  let mx = full.max[lo];
  for (let j = lo; j < hi; j++) {
    if (full.min[j] < mn) mn = full.min[j];
    if (full.max[j] > mx) mx = full.max[j];
  }
  return [mn, mx];
}

/**
 * Derives a `outBuckets`-wide view [viewStart, viewEnd) from a pre-fetched
 * whole-track peaks array (spanning [0, full duration]) -- min-of-mins /
 * max-of-maxes over the source buckets each output bucket covers, which is
 * exact (no precision lost beyond what the original server-side bucketing
 * already introduced). This is what makes zoom/pan instant: no network call,
 * just re-slicing data already in memory. Below the source's own
 * resolution (zoomed in tighter than FULL_TRACK_BUCKETS can resolve), output
 * buckets start repeating the same one or two source buckets -- a known,
 * accepted trade-off (see FULL_TRACK_BUCKETS/MIN_VIEW_DURATION_S) rather
 * than falling back to a live fetch.
 */
function resamplePeaks(full: FullPeaks, fullDuration: number, viewStart: number, viewEnd: number, outBuckets: number): PeaksData {
  const n = full.min.length;
  if (n === 0 || fullDuration <= 0) return { min: [], max: [], dataStart: viewStart, dataEnd: viewStart };

  const srcBucketDur = fullDuration / n;
  const clampedStart = Math.max(0, viewStart);
  const clampedEnd = Math.min(fullDuration, viewEnd);
  if (clampedEnd <= clampedStart) return { min: [], max: [], dataStart: viewStart, dataEnd: viewStart };

  const startIdx = Math.max(0, Math.floor(clampedStart / srcBucketDur));
  const endIdx = Math.min(n, Math.ceil(clampedEnd / srcBucketDur));
  const sliceLen = endIdx - startIdx;
  if (sliceLen <= 0) return { min: [], max: [], dataStart: viewStart, dataEnd: viewStart };

  const outMin = new Array<number>(outBuckets);
  const outMax = new Array<number>(outBuckets);
  for (let i = 0; i < outBuckets; i++) {
    const a = startIdx + Math.floor((i / outBuckets) * sliceLen);
    const b = startIdx + Math.floor(((i + 1) / outBuckets) * sliceLen);
    const lo = Math.min(a, n - 1);
    const hi = Math.max(lo + 1, Math.min(b, n));
    let mn = full.min[lo];
    let mx = full.max[lo];
    for (let j = lo; j < hi; j++) {
      if (full.min[j] < mn) mn = full.min[j];
      if (full.max[j] > mx) mx = full.max[j];
    }
    outMin[i] = mn;
    outMax[i] = mx;
  }
  return { min: outMin, max: outMax, dataStart: startIdx * srcBucketDur, dataEnd: endIdx * srcBucketDur };
}

/** Fetches+decodes a clip into a ready-to-schedule AudioBuffer. Decoding
 * up front (rather than handing a <audio> element a src and hoping it
 * buffers in time) is what lets playback below start multiple sources at a
 * genuinely identical, sample-accurate instant -- see playSource. */
async function decodeClip(ctx: AudioContext, blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

/** Stops (if playing) and detaches a previous source; a AudioBufferSourceNode
 * can only ever be started once, so every (re)play/seek creates a fresh one. */
function stopSource(ref: React.MutableRefObject<AudioBufferSourceNode | null>) {
  if (ref.current) {
    try {
      ref.current.stop();
    } catch {
      // Already stopped or never started -- fine, that's what we wanted anyway.
    }
    try {
      ref.current.disconnect();
    } catch {
      // noop
    }
    ref.current = null;
  }
}

/** Schedules `buffer` to start at the AudioContext-clock instant `when`,
 * `offset` seconds into the buffer. `when`/`offset` being expressed on the
 * shared audio clock (not JS timers, not per-element readiness) is what
 * guarantees multiple sources started this way are audibly simultaneous. */
function playSource(ctx: AudioContext, buffer: AudioBuffer, gain: GainNode, when: number, offset: number): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  source.start(when, Math.max(0, Math.min(offset, buffer.duration)));
  return source;
}

interface TrackPreviewProps {
  /** Usually the same file (single-file mode's reference and candidate
   * tracks live side by side in one container) but not always: batch mode's
   * cross-file pairs have the reference in one file and the track to
   * correct in another, and /clip and /waveform both take a `path` per
   * call, so there's no reason this component needs them to match. */
  referenceFilePath: string;
  candidateFilePath: string;
  referenceIndex: number;
  trackIndex: number;
  segments: SegmentOut[];
  /** Each track's container-level presentation delay (0 if none), purely
   * informational: every extraction here (waveforms, clips, detection) works
   * on each track's own timeline with that delay excluded (see the engine's
   * _seek_args), so no playback/waveform math uses these values. */
  referenceStartTime: number;
  trackStartTime: number;
  /** Lets a parent move the playback position (the segment editor's chart,
   * clicked like a waveform). */
  controller?: React.Ref<TrackPreviewHandle>;
  /** The playback marker's reference time, as it moves -- for a parent to
   * draw the same marker elsewhere. */
  onCursorChange?: (t: number) => void;
}

export interface TrackPreviewHandle {
  seekTo(t: number): void;
}

// After the segments change while playing, the loaded "Résultat final" clip
// no longer matches them: it's reloaded once edits pause for this long.
const RELOAD_AFTER_EDIT_MS = 400;

/** Compare the reference and a candidate track together -- always-visible,
 * zoomable waveforms (reference / candidate as-is / corrected result, the
 * last two git-diff-highlighted) plus actual audio playback -- to check a
 * correction by eye and by ear before spending a full render on it.
 *
 * Playback uses the Web Audio API (AudioContext + AudioBufferSourceNode),
 * not plain <audio> elements: three separate <audio>.play() calls have no
 * guaranteed simultaneity (each has its own, variable, buffering-dependent
 * startup latency), which was audible as "Résultat final starts late"
 * whenever there wasn't a deliberate leading-silence wait long enough to
 * absorb that jitter for free. Scheduling all three AudioBufferSourceNodes
 * against the same AudioContext clock (`start(when, offset)`) starts them
 * at a genuinely identical instant instead. */
export function TrackPreview({
  referenceFilePath,
  candidateFilePath,
  referenceIndex,
  trackIndex,
  segments,
  referenceStartTime,
  trackStartTime,
  controller,
  onCursorChange,
}: TrackPreviewProps) {
  const [previewStart, setPreviewStart] = useState(() => (segments.length ? segments[0].start_s : 0));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where the currently-loaded clips actually start, in reference time --
  // diverges from `previewStart` once an in-clip seek moves the marker
  // without reloading (see handleWaveformSeek), so playback-offset math
  // must be anchored on this, not on `previewStart`.
  const [loadedClipStart, setLoadedClipStart] = useState<number | null>(null);
  const [refMuted, setRefMuted] = useState(false);
  const [candMuted, setCandMuted] = useState(false);
  const [candOriginalMuted, setCandOriginalMuted] = useState(false);
  // Only set while audio is actually playing (see startCursorLoop); when
  // null, the displayed marker falls back to `previewStart` below, so the
  // red line is always shown, not just during playback.
  const [liveCursor, setLiveCursor] = useState<number | null>(null);

  const [refDuration, setRefDuration] = useState<number | null>(null);
  const [candDuration, setCandDuration] = useState<number | null>(null);
  const [viewStart, setViewStart] = useState(0);
  const [viewDuration, setViewDuration] = useState<number | null>(null);
  // Whole-track peaks, fetched once (see the prefetch effect below) -- every
  // zoom/pan re-derives its view from these via resamplePeaks, no refetch.
  const [refFullPeaks, setRefFullPeaks] = useState<FullPeaks | null>(null);
  const [candFullPeaks, setCandFullPeaks] = useState<FullPeaks | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const refGainRef = useRef<GainNode | null>(null);
  const candGainRef = useRef<GainNode | null>(null);
  const candOriginalGainRef = useRef<GainNode | null>(null);
  const refSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const candSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const candOriginalSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // The currently-loaded, already-decoded buffers -- kept around so an
  // in-clip seek (handleWaveformSeek) can reschedule instantly from memory
  // instead of re-fetching/re-decoding.
  const refBufferRef = useRef<AudioBuffer | null>(null);
  const candBufferRef = useRef<AudioBuffer | null>(null);
  const candOriginalBufferRef = useRef<AudioBuffer | null>(null);
  // When playback last (re)started: the AudioContext-clock instant it began
  // at, and what reference-time that corresponds to -- the cursor loop below
  // derives the live position from `ctx.currentTime - contextTime`.
  const playbackStartRef = useRef<{ contextTime: number; refTime: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Bumped on every loadAndPlay call; lets a stale call recognize it's been
  // superseded by a newer one (e.g. a rapid re-seek) and ignore its own
  // late-arriving fetch/decode results instead of clobbering a newer load.
  const loadGenerationRef = useRef(0);
  // The live playback position, readable from timers (state would be stale there).
  const cursorRef = useRef<number | null>(null);

  const appliedOffset = offsetAt(segments, previewStart);
  const displayCursor = liveCursor ?? previewStart;

  useEffect(() => {
    onCursorChange?.(displayCursor);
  }, [displayCursor, onCursorChange]);

  // Compared by content: a parent editing segments may hand a new array with
  // the same values on every render.
  const segmentsKey = JSON.stringify(segments);
  const lastSegmentsKeyRef = useRef(segmentsKey);
  useEffect(() => {
    if (segmentsKey === lastSegmentsKeyRef.current) return;
    lastSegmentsKeyRef.current = segmentsKey;
    // The decoded "Résultat final" was built from the old segments: never
    // reuse it for an in-clip seek.
    setLoadedClipStart(null);
    if (playbackStartRef.current === null) return;
    const timer = setTimeout(() => {
      const at = cursorRef.current;
      if (at !== null && playbackStartRef.current !== null) loadAndPlay(Math.round(at * 10) / 10);
    }, RELOAD_AFTER_EDIT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsKey]);

  useImperativeHandle(controller, () => ({ seekTo: handleWaveformSeek }));
  // Informational only (see TrackPreviewProps' comment): the offset above is
  // measured on each track's own timeline, container delay excluded, so a
  // normal player (which applies that delay) would see this residual instead.
  const hasContainerDelay = Math.abs(trackStartTime) > 0.001 || Math.abs(referenceStartTime) > 0.001;
  const presentationOffset = appliedOffset + trackStartTime - referenceStartTime;

  function getAudioCtx(): AudioContext {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }

  function getGain(ref: React.MutableRefObject<GainNode | null>, ctx: AudioContext, muted: boolean): GainNode {
    if (!ref.current) {
      ref.current = ctx.createGain();
      ref.current.connect(ctx.destination);
    }
    ref.current.gain.value = muted ? 0 : 1;
    return ref.current;
  }

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      stopSource(refSourceRef);
      stopSource(candSourceRef);
      stopSource(candOriginalSourceRef);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Fetch each track's whole-file peaks once, at high enough resolution
  // that every zoom/pan afterwards is a pure client-side resample -- this is
  // what makes the waveform "always visible, whole track" *and* instant to
  // navigate, instead of gated behind a play click or a fetch per zoom step.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setWaveformLoading(true);
      setWaveformError(null);
      try {
        const [refWave, candWave] = await Promise.all([
          fetchWaveform(referenceFilePath, referenceIndex, 0, null, FULL_TRACK_BUCKETS),
          fetchWaveform(candidateFilePath, trackIndex, 0, null, FULL_TRACK_BUCKETS),
        ]);
        if (cancelled) return;
        setRefDuration(refWave.duration);
        setCandDuration(candWave.duration);
        setRefFullPeaks({ min: refWave.peaks_min, max: refWave.peaks_max });
        setCandFullPeaks({ min: candWave.peaks_min, max: candWave.peaks_max });
        setViewStart(0);
        setViewDuration(refWave.duration);
      } catch (err) {
        if (!cancelled) setWaveformError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setWaveformLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [referenceFilePath, candidateFilePath, referenceIndex, trackIndex]);

  const plan = useMemo(() => planResult(segments), [segments]);

  // Re-derive all three waveforms' data for the current view from the
  // already-fetched full-track peaks -- synchronous, no network round trip,
  // so zoom/pan feels instant no matter how far in or out.
  const viewData = useMemo(() => {
    if (viewDuration === null || refDuration === null || candDuration === null || !refFullPeaks || !candFullPeaks) {
      return null;
    }
    const viewEnd = viewStart + viewDuration;
    const refPeaks = resamplePeaks(refFullPeaks, refDuration, viewStart, viewEnd, WAVEFORM_BUCKETS);
    // Track 2 (candidate, as-is): the SAME numeric window as the reference
    // view -- not offset-shifted -- so the correction is directly visible as
    // a spatial shift between the two waveforms, the same way two git diff
    // panes line up by position.
    const candPeaks = resamplePeaks(candFullPeaks, candDuration, viewStart, viewEnd, WAVEFORM_BUCKETS);

    // Track 3 (corrected result): each point shows the candidate audio the
    // render will actually put there -- per its own segment, with skipped
    // excess and silenced gaps exactly as the render does them (see
    // resultPlan), not one offset applied to the whole view.
    const finalMin = new Array<number>(WAVEFORM_BUCKETS).fill(0);
    const finalMax = new Array<number>(WAVEFORM_BUCKETS).fill(0);
    const step = viewDuration / WAVEFORM_BUCKETS;
    for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const span of candidateSpansIn(plan, viewStart + i * step, viewStart + (i + 1) * step, candDuration)) {
        const range = peakRange(candFullPeaks, candDuration, span.start, span.end);
        if (!range) continue;
        mn = Math.min(mn, range[0]);
        mx = Math.max(mx, range[1]);
      }
      if (mn <= mx) {
        finalMin[i] = mn;
        finalMax[i] = mx;
      }
    }
    const finalPeaks: PeaksData = { min: finalMin, max: finalMax, dataStart: viewStart, dataEnd: viewEnd };

    return {
      refPeaks,
      candPeaks,
      finalPeaks,
      removed: skippedRegions(plan, candDuration),
      added: silentRegions(plan, candDuration),
    };
  }, [viewStart, viewDuration, refDuration, candDuration, refFullPeaks, candFullPeaks, plan]);

  /** Zoom by `factor` (< 1 zooms in, > 1 zooms out), keeping `centerTime` at
   * the same relative position in the view -- so a wheel-zoom stays anchored
   * under the cursor instead of recentering the whole view. */
  function zoomAt(factor: number, centerTime: number) {
    if (viewDuration === null || refDuration === null) return;
    const newDuration = Math.max(MIN_VIEW_DURATION_S, Math.min(refDuration, viewDuration * factor));
    const frac = viewDuration > 0 ? (centerTime - viewStart) / viewDuration : 0.5;
    let newStart = centerTime - frac * newDuration;
    newStart = Math.max(0, Math.min(Math.max(0, refDuration - newDuration), newStart));
    setViewStart(newStart);
    setViewDuration(newDuration);
  }

  function resetZoom() {
    if (refDuration === null) return;
    setViewStart(0);
    setViewDuration(refDuration);
  }

  function stopCursorLoop() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    cursorRef.current = null;
    setLiveCursor(null);
  }

  function startCursorLoop() {
    function tick() {
      const ctx = audioCtxRef.current;
      const start = playbackStartRef.current;
      const refBuffer = refBufferRef.current;
      if (ctx && start && refBuffer) {
        const elapsed = ctx.currentTime - start.contextTime;
        // elapsed < 0 just means playback is still in its scheduled lead-in
        // (see the `when = ctx.currentTime + 0.05` in loadAndPlay/
        // handleWaveformSeek) -- keep looping without moving the marker yet,
        // don't treat "hasn't started" the same as "finished".
        if (elapsed <= refBuffer.duration) {
          if (elapsed >= 0) {
            cursorRef.current = start.refTime + elapsed;
            setLiveCursor(cursorRef.current);
          }
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
      }
      stopCursorLoop();
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  /** Loads a fresh 12s clip pair starting at `startAt` (defaults to the
   * current position field), decodes them, and schedules all three to start
   * together. Takes an explicit argument rather than always reading
   * `previewStart` so a click-to-seek during playback (see
   * handleWaveformSeek) can jump straight to the clicked time without
   * waiting for the state update to land first. */
  async function loadAndPlay(startAt: number = previewStart) {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      // "Résultat final" is rendered by the engine with the render's own
      // filter over this exact reference span, so all three clips share
      // one timeline and start together.
      const [refBlob, candBlob, candOriginalBlob] = await Promise.all([
        fetchClip(referenceFilePath, referenceIndex, startAt, PREVIEW_DURATION_S),
        fetchCorrectedClip(candidateFilePath, trackIndex, segments, startAt, PREVIEW_DURATION_S),
        fetchClip(candidateFilePath, trackIndex, startAt, PREVIEW_DURATION_S),
      ]);
      if (loadGenerationRef.current !== generation) return; // superseded while fetching

      const ctx = getAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const [refBuffer, candBuffer, candOriginalBuffer] = await Promise.all([
        decodeClip(ctx, refBlob),
        decodeClip(ctx, candBlob),
        decodeClip(ctx, candOriginalBlob),
      ]);
      if (loadGenerationRef.current !== generation) return; // superseded while decoding

      refBufferRef.current = refBuffer;
      candBufferRef.current = candBuffer;
      candOriginalBufferRef.current = candOriginalBuffer;
      setLoadedClipStart(startAt);
      setLoading(false);

      const refGain = getGain(refGainRef, ctx, refMuted);
      const candGain = getGain(candGainRef, ctx, candMuted);
      const candOriginalGain = getGain(candOriginalGainRef, ctx, candOriginalMuted);

      stopSource(refSourceRef);
      stopSource(candSourceRef);
      stopSource(candOriginalSourceRef);

      // A small fixed lead time (not "now") so all three .start() calls --
      // themselves not perfectly instantaneous -- still land before the
      // instant they're scheduled for, guaranteeing they're simultaneous
      // rather than racing each other.
      const when = ctx.currentTime + 0.05;
      refSourceRef.current = playSource(ctx, refBuffer, refGain, when, 0);
      candOriginalSourceRef.current = playSource(ctx, candOriginalBuffer, candOriginalGain, when, 0);
      candSourceRef.current = playSource(ctx, candBuffer, candGain, when, 0);

      playbackStartRef.current = { contextTime: when, refTime: startAt };
      startCursorLoop();
    } catch (err) {
      if (loadGenerationRef.current !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  /** Click-to-seek on any of the three waveforms. If the clicked time is
   * still within the clip currently loaded for playback, reschedule all
   * three from the already-decoded buffers in memory (instant, no network
   * round trip); otherwise, if something was playing, reload a fresh clip
   * starting there so listening continues uninterrupted instead of silently
   * going stale. Either way, the position field (and thus the always-visible
   * marker) follows the click. */
  function handleWaveformSeek(t: number) {
    const rounded = Math.round(t * 10) / 10;
    const ctx = audioCtxRef.current;
    const wasPlaying = playbackStartRef.current !== null && ctx !== null;
    const withinLoadedClip =
      loadedClipStart !== null && t >= loadedClipStart && t <= loadedClipStart + PREVIEW_DURATION_S;

    setPreviewStart(rounded);

    if (
      withinLoadedClip &&
      wasPlaying &&
      ctx &&
      refBufferRef.current &&
      candBufferRef.current &&
      candOriginalBufferRef.current &&
      refGainRef.current &&
      candGainRef.current &&
      candOriginalGainRef.current
    ) {
      // All three clips share the reference timeline (see loadAndPlay).
      const clipOffset = t - loadedClipStart!;

      const when = ctx.currentTime + 0.02;
      stopSource(refSourceRef);
      stopSource(candOriginalSourceRef);
      stopSource(candSourceRef);

      refSourceRef.current = playSource(ctx, refBufferRef.current, refGainRef.current, when, clipOffset);
      candOriginalSourceRef.current = playSource(ctx, candOriginalBufferRef.current, candOriginalGainRef.current, when, clipOffset);
      candSourceRef.current = playSource(ctx, candBufferRef.current, candGainRef.current, when, clipOffset);
      playbackStartRef.current = { contextTime: when, refTime: t };
      cursorRef.current = t;
      setLiveCursor(t);
      return;
    }

    if (wasPlaying) {
      loadAndPlay(rounded);
    }
  }

  /** Jump the position (and zoom the view) to segment `seg` -- avoids the
   * user having to eyeball the chart or hunt through a whole-track view to
   * land inside the right segment. */
  function goToSegment(seg: SegmentOut) {
    setPreviewStart(Math.round(((seg.start_s + seg.end_s) / 2) * 10) / 10);
    setViewStart(seg.start_s);
    setViewDuration(Math.max(MIN_VIEW_DURATION_S, seg.end_s - seg.start_s));
  }

  function stop() {
    stopSource(refSourceRef);
    stopSource(candSourceRef);
    stopSource(candOriginalSourceRef);
    playbackStartRef.current = null;
    stopCursorLoop();
  }

  const removedHighlight: HighlightRegion[] = (viewData?.removed ?? []).map((r) => ({ ...r, kind: "removed" }));
  const addedHighlight: HighlightRegion[] = (viewData?.added ?? []).map((r) => ({ ...r, kind: "added" }));

  return (
    <div className="preview">
      {segments.length > 1 && (
        <div className="preview-segment-picks">
          Aller à :
          {segments.map((seg, i) => (
            <button key={i} className="small-button" onClick={() => goToSegment(seg)}>
              {formatTime(seg.start_s)}–{formatTime(seg.end_s)} (
              {((seg.offset_start + seg.offset_end) / 2).toFixed(2)}s)
            </button>
          ))}
        </div>
      )}

      <div className="waveform-zoom-controls">
        <span>Zoom :</span>
        <button className="small-button" onClick={() => zoomAt(0.5, previewStart)}>
          + (zoomer)
        </button>
        <button className="small-button" onClick={() => zoomAt(2, previewStart)}>
          − (dézoomer)
        </button>
        <button className="small-button" onClick={resetZoom}>
          Piste entière
        </button>
        <span className="preview-offset">molette = zoomer/dézoomer sous le curseur</span>
      </div>

      {(removedHighlight.length > 0 || addedHighlight.length > 0) && (
        <div className="waveform-legend">
          <span>
            <span className="waveform-legend-swatch removed" /> sera supprimé
          </span>
          <span>
            <span className="waveform-legend-swatch added" /> sera ajouté (silence)
          </span>
        </div>
      )}

      {waveformError && <p className="error">{waveformError}</p>}

      {waveformLoading && !viewData && <p className="placeholder">Chargement des formes d'onde...</p>}

      {viewDuration !== null && viewData && (
        <div className="waveforms">
          <Waveform
            viewStart={viewStart}
            viewDuration={viewDuration}
            peaksMin={viewData.refPeaks.min}
            peaksMax={viewData.refPeaks.max}
            dataStart={viewData.refPeaks.dataStart}
            dataEnd={viewData.refPeaks.dataEnd}
            cursor={displayCursor}
            onSeek={handleWaveformSeek}
            onZoom={zoomAt}
            label="Référence"
            className="waveform-reference"
          />
          <Waveform
            viewStart={viewStart}
            viewDuration={viewDuration}
            peaksMin={viewData.candPeaks.min}
            peaksMax={viewData.candPeaks.max}
            dataStart={viewData.candPeaks.dataStart}
            dataEnd={viewData.candPeaks.dataEnd}
            cursor={displayCursor}
            onSeek={handleWaveformSeek}
            onZoom={zoomAt}
            highlights={removedHighlight}
            label="Piste corrigée (originale)"
            className="waveform-candidate"
          />
          <Waveform
            viewStart={viewStart}
            viewDuration={viewDuration}
            peaksMin={viewData.finalPeaks.min}
            peaksMax={viewData.finalPeaks.max}
            dataStart={viewData.finalPeaks.dataStart}
            dataEnd={viewData.finalPeaks.dataEnd}
            cursor={displayCursor}
            onSeek={handleWaveformSeek}
            onZoom={zoomAt}
            highlights={addedHighlight}
            label="Résultat final"
            className="waveform-final"
          />
        </div>
      )}

      {refDuration !== null && refFullPeaks && viewDuration !== null && (
        <WaveformNavigator
          duration={refDuration}
          viewStart={viewStart}
          viewDuration={viewDuration}
          peaksMin={refFullPeaks.min}
          peaksMax={refFullPeaks.max}
          onNavigate={setViewStart}
        />
      )}

      <div className="preview-controls">
        <label>
          Position (s) :
          <input
            type="number"
            step="0.5"
            min="0"
            value={previewStart}
            onChange={(e) => setPreviewStart(Number(e.target.value))}
          />
        </label>
        <button className="small-button" onClick={() => loadAndPlay()} disabled={loading}>
          {loading ? "Chargement..." : "Écouter"}
        </button>
        <button className="small-button" onClick={stop} disabled={loadedClipStart === null && liveCursor === null}>
          Arrêter
        </button>
        <label>
          <input
            type="checkbox"
            checked={!refMuted}
            onChange={() =>
              setRefMuted((m) => {
                const next = !m;
                if (refGainRef.current) refGainRef.current.gain.value = next ? 0 : 1;
                return next;
              })
            }
          />
          Référence
        </label>
        <label>
          <input
            type="checkbox"
            checked={!candOriginalMuted}
            onChange={() =>
              setCandOriginalMuted((m) => {
                const next = !m;
                if (candOriginalGainRef.current) candOriginalGainRef.current.gain.value = next ? 0 : 1;
                return next;
              })
            }
          />
          Piste corrigée (originale)
        </label>
        <label>
          <input
            type="checkbox"
            checked={!candMuted}
            onChange={() =>
              setCandMuted((m) => {
                const next = !m;
                if (candGainRef.current) candGainRef.current.gain.value = next ? 0 : 1;
                return next;
              })
            }
          />
          Résultat final
        </label>
        <span className="preview-offset">Décalage à cette position : {appliedOffset.toFixed(3)} s</span>
        {hasContainerDelay && (
          <span className="preview-offset" title="Le décalage ci-dessus (utilisé pour la lecture et l'export) est mesuré sur la piste brute, sans son délai de conteneur -- ce nombre est juste informatif.">
            (dont {trackStartTime.toFixed(3)} s déjà présents dans le conteneur pour cette piste ; décalage restant dans un lecteur ≈ {presentationOffset.toFixed(3)} s)
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
