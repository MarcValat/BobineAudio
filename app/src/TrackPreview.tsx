import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fetchClip, fetchCorrectedClip, fetchWaveform, type SegmentOut } from "./api";
import { candidateSpansIn, planResult, silentRegions, skippedRegions } from "./resultPlan";
import { InfoTip, Tooltip } from "./InfoTip";
import { Select } from "./Dropdown";
import { MIN_VIEW_DURATION_S, panView, type TimeView, zoomView } from "./timeView";
import { formatOffsetMs, formatTime, segmentOffsetLabel } from "./SegmentChart";
import { Waveform, type HighlightRegion } from "./Waveform";
import { WaveformNavigator } from "./WaveformNavigator";
import { errorMessage, inFront, shortcutKey } from "./util";
import { FULL_TRACK_BUCKETS, peakRange, resamplePeaks, type FullPeaks, type PeaksData } from "./peaks";
import { MinusIcon, PlusIcon } from "./icons";
import { useT } from "./i18n";

const PREVIEW_DURATION_S = 12;
const WAVEFORM_BUCKETS = 800;

// Waveforms loaded ahead, one at a time: they share the engine with the
// analyses still running.
let preloading: Promise<unknown> = Promise.resolve();

/** Loads a corrected track's waveforms (its reference's and its own) in
 * the background, as soon as it's analyzed: they're ready, kept by
 * fetchWaveform, when its file or pair is shown. */
export function preloadWaveforms(referencePath: string, referenceIndex: number, candidatePath: string, trackIndex: number): void {
  preloading = preloading
    .then(() =>
      Promise.all([
        fetchWaveform(referencePath, referenceIndex, 0, null, FULL_TRACK_BUCKETS),
        fetchWaveform(candidatePath, trackIndex, 0, null, FULL_TRACK_BUCKETS),
      ]),
    )
    .catch(() => {
      // the preview asks again when shown, and shows the error then
    });
}

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
  /** Usually the same file (multitrack mode's reference and candidate
   * tracks live side by side in one container) but not always: the
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
  onCursorChange?: (t: number, playing: boolean) => void;
  /** With both, the visible stretch is the parent's (null: not set yet),
   * shared with its own chart, instead of this component's own. */
  view?: TimeView | null;
  onViewChange?: (view: TimeView) => void;
  /** More buttons at the right end of the zoom row (the detail's
   * "Journal"): the playback row has no room left in a small window. */
  extraControls?: React.ReactNode;
  /** False while it's out of sight (its mode hidden): playback stops. */
  active?: boolean;
}

// The listening position of each track pair, kept while its preview comes
// and goes: the detail's and the editor's are one, closing the editor
// keeps where it was.
const positions = new Map<string, number>();

// A clip starts at least this long before the track's end: one starting
// at the very end would be empty (it can't even be decoded).
const MIN_CLIP_S = 1;

export interface TrackPreviewHandle {
  seekTo(t: number): void;
  /** The marker dragged to `t` (a parent's chart), then let go there. */
  scrubTo(t: number): void;
  endScrub(t: number): void;
  /** The view moved by a share of its length. */
  pan(share: number): void;
}

function segmentPickLabel(seg: SegmentOut): string {
  return `${formatTime(seg.start_s)}–${formatTime(seg.end_s)} (${segmentOffsetLabel(seg)})`;
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
  view: sharedView,
  onViewChange,
  extraControls,
  active = true,
}: TrackPreviewProps) {
  const t = useT();
  const positionKey = `${referenceFilePath}|${referenceIndex}|${candidateFilePath}|${trackIndex}`;
  const [previewStart, setPreviewStartState] = useState(() => positions.get(positionKey) ?? (segments.length ? segments[0].start_s : 0));
  function setPreviewStart(t: number) {
    setPreviewStartState(t);
    positions.set(positionKey, t);
  }
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
  const [ownView, setOwnView] = useState<TimeView | null>(null);
  const currentView = sharedView !== undefined ? sharedView : ownView;
  const viewStart = currentView?.start ?? 0;
  const viewDuration = currentView?.duration ?? null;
  function setView(next: TimeView) {
    setOwnView(next);
    onViewChange?.(next);
  }
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
  // While the marker is dragged: where it is (it follows the pointer;
  // playback goes there once it's let go).
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const displayCursor = scrubTime ?? liveCursor ?? previewStart;
  // It moves by itself (playing) or under the pointer: no glide then.
  const markerMoving = liveCursor !== null || scrubTime !== null;

  useEffect(() => {
    onCursorChange?.(displayCursor, markerMoving);
  }, [displayCursor, markerMoving, onCursorChange]);

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

  /** `t` brought within the track, a clip's length before its end. */
  function clampStart(t: number): number {
    const end = refDuration !== null ? Math.max(0, refDuration - MIN_CLIP_S) : Infinity;
    return Math.round(Math.max(0, Math.min(Number.isFinite(t) ? t : 0, end)) * 10) / 10;
  }

  // Out of sight (its mode hidden): it goes quiet.
  useEffect(() => {
    if (!active && playbackStartRef.current !== null) stop();
    if (!active) {
      // A clip on its way is dropped, and the button freed.
      loadGenerationRef.current++;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** A drag of the marker let go at `t`: the position goes there. */
  function endScrub(t: number) {
    setScrubTime(null);
    handleWaveformSeek(t);
  }

  /** The view moved by `share` of its length (a middle-button drag). */
  function pan(share: number) {
    if (refDuration === null || viewDuration === null) return;
    setView(panView({ start: viewStart, duration: viewDuration }, share * viewDuration, refDuration));
  }

  useImperativeHandle(controller, () => ({ seekTo: handleWaveformSeek, scrubTo: setScrubTime, endScrub, pan }));
  // Informational only (see TrackPreviewProps' comment): the offset above is
  // measured on each track's own timeline, container delay excluded, so a
  // normal player (which applies that delay) would see this residual instead.
  const hasContainerDelay = Math.abs(trackStartTime) > 0.001 || Math.abs(referenceStartTime) > 0.001;
  const presentationOffset = appliedOffset + trackStartTime - referenceStartTime;

  // Gone: no audio context may be created any more.
  const unmountedRef = useRef(false);

  function getAudioCtx(): AudioContext {
    if (unmountedRef.current) throw new Error("preview closed");
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
    // (Mounted again: React's development mode unmounts and remounts once.)
    unmountedRef.current = false;
    return () => {
      // A clip still on its way is dropped (it would start playing after
      // the preview is gone, with nothing left to stop it).
      loadGenerationRef.current++;
      unmountedRef.current = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      stopSource(refSourceRef);
      stopSource(candSourceRef);
      stopSource(candOriginalSourceRef);
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      refGainRef.current = null;
      candGainRef.current = null;
      candOriginalGainRef.current = null;
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
        setView({ start: 0, duration: refWave.duration });
      } catch (err) {
        if (!cancelled) setWaveformError(errorMessage(err));
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
    setView(zoomView({ start: viewStart, duration: viewDuration }, factor, centerTime, refDuration));
  }

  function resetZoom() {
    if (refDuration === null) return;
    setView({ start: 0, duration: refDuration });
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
      // Played to the end of the clip: nothing plays any more.
      playbackStartRef.current = null;
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
  async function loadAndPlay(requested: number = previewStart) {
    const generation = ++loadGenerationRef.current;
    // Within the track: a position typed past its end (or left from a
    // longer one) would ask the engine for nothing -- an error 400.
    const startAt = clampStart(requested);
    if (startAt !== requested) setPreviewStart(startAt);
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
      setError(errorMessage(err));
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
    const withinLoadedClip = loadedClipStart !== null && t >= loadedClipStart && t <= loadedClipStart + PREVIEW_DURATION_S;

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
    setView({ start: seg.start_s, duration: Math.max(MIN_VIEW_DURATION_S, seg.end_s - seg.start_s) });
  }

  function stop() {
    stopSource(refSourceRef);
    stopSource(candSourceRef);
    stopSource(candOriginalSourceRef);
    playbackStartRef.current = null;
    stopCursorLoop();
  }

  // "Décalage ici", at the result's label (where the position plays).
  const offsetHere = (
    <span className="preview-offset">
      {t.preview.offsetHere(formatOffsetMs(appliedOffset))}
      {hasContainerDelay && (
        <>
          {" "}
          <InfoTip>{t.preview.containerDelay(formatOffsetMs(trackStartTime), formatOffsetMs(presentationOffset))}</InfoTip>
        </>
      )}
    </span>
  );

  const removedHighlight: HighlightRegion[] = (viewData?.removed ?? []).map((r) => ({ ...r, kind: "removed" }));
  const addedHighlight: HighlightRegion[] = (viewData?.added ?? []).map((r) => ({ ...r, kind: "added" }));

  // Space plays from the position, or stops: the shown preview only (not
  // one hidden on the other mode or tab, nor behind a dialog).
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef(() => {});
  // (Nothing while a clip loads: it would start once loaded anyway.)
  toggle.current = () => {
    if (playbackStartRef.current !== null) stop();
    else if (!loading) loadAndPlay();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || !shortcutKey(e) || !root.current?.offsetParent || !inFront(root.current)) return;
      e.preventDefault();
      toggle.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="preview" ref={root}>
      {/* One row (zoom, the segments to go to, the journal): height is what
          a small window lacks. */}
      <div className="preview-toolbar">
        <div className="waveform-zoom-controls">
          <span>{t.preview.zoom}</span>
          <Tooltip text={t.preview.zoomIn}>
            <button className="small-button zoom-button" aria-label={t.preview.zoomIn} onClick={() => zoomAt(0.5, previewStart)}>
              <PlusIcon />
            </button>
          </Tooltip>
          <Tooltip text={t.preview.zoomOut}>
            <button className="small-button zoom-button" aria-label={t.preview.zoomOut} onClick={() => zoomAt(2, previewStart)}>
              <MinusIcon />
            </button>
          </Tooltip>
          <button className="small-button" onClick={resetZoom}>
            {t.preview.wholeTrack}
          </button>
          <InfoTip>{t.preview.zoomHint}</InfoTip>
        </div>
        {/* A list, not a button per segment: the row stays one line, the
            height is the waveforms'. */}
        {segments.length > 1 && (
          <span className="preview-segment-picks">
            {t.preview.goTo}
            <Select
              label={t.preview.goTo}
              value=""
              placeholder={t.preview.aSegment(segments.length)}
              options={segments.map((seg, i) => ({ value: String(i), label: `${i + 1}. ${segmentPickLabel(seg)}` }))}
              onChange={(i) => {
                const seg = segments[Number(i)];
                if (seg) goToSegment(seg);
              }}
            />
          </span>
        )}
        {extraControls && <span className="preview-extra">{extraControls}</span>}
      </div>

      {waveformError && <p className="error">{waveformError}</p>}

      {/* Until they're in, their room is kept (empty frames, a spinner):
          the controls below don't jump when they arrive. */}
      {!viewData && !waveformError && (
        <div className="waveforms waveforms-loading" aria-busy="true">
          {[
            [t.preview.reference, "waveform-reference"],
            [t.preview.candidate, "waveform-candidate"],
            [t.preview.result, "waveform-final"],
          ].map(([label, className]) => (
            <div key={className} className={`waveform ${className}`}>
              <div className="waveform-label">{label}</div>
            </div>
          ))}
          {waveformLoading && (
            <span className="waveforms-spinner">
              <span className="spinner spinner-small" />
              {t.preview.loadingWaveforms}
            </span>
          )}
        </div>
      )}

      {viewDuration !== null && viewData && (
        <div className="waveforms">
          {/* The reference, the track as is (what's removed in red), the
              result (what's added in green, the offset at the position):
              one time scale, one position. */}
          {(
            [
              [t.preview.reference, "waveform-reference", viewData.refPeaks, undefined, null],
              [
                t.preview.candidate,
                "waveform-candidate",
                viewData.candPeaks,
                removedHighlight,
                removedHighlight.length > 0 && (
                  <span>
                    <span className="waveform-legend-swatch removed" /> {t.preview.willBeRemoved}
                  </span>
                ),
              ],
              [
                t.preview.result,
                "waveform-final",
                viewData.finalPeaks,
                addedHighlight,
                <>
                  {addedHighlight.length > 0 && (
                    <span>
                      <span className="waveform-legend-swatch added" /> {t.preview.willBeAdded}
                    </span>
                  )}
                  {offsetHere}
                </>,
              ],
            ] as const
          ).map(([label, className, peaks, highlights, labelExtra]) => (
            <Waveform
              key={className}
              viewStart={viewStart}
              viewDuration={viewDuration}
              peaksMin={peaks.min}
              peaksMax={peaks.max}
              dataStart={peaks.dataStart}
              dataEnd={peaks.dataEnd}
              cursor={displayCursor}
              cursorGlide={!markerMoving}
              onSeek={handleWaveformSeek}
              onScrub={setScrubTime}
              onScrubEnd={endScrub}
              onPan={pan}
              onZoom={zoomAt}
              highlights={highlights}
              label={label}
              labelExtra={labelExtra}
              className={className}
            />
          ))}
        </div>
      )}

      {!(refDuration !== null && refFullPeaks && viewDuration !== null) && !waveformError && (
        <div className="waveform-navigator waveform-navigator-placeholder" />
      )}
      {refDuration !== null && refFullPeaks && viewDuration !== null && (
        <WaveformNavigator
          duration={refDuration}
          viewStart={viewStart}
          viewDuration={viewDuration}
          peaksMin={refFullPeaks.min}
          peaksMax={refFullPeaks.max}
          onNavigate={(start) => setView({ start, duration: viewDuration })}
        />
      )}

      <div className="preview-controls">
        <label>
          {t.preview.position}
          <input
            type="number"
            step="0.5"
            min="0"
            // While the marker is dragged, where it would land.
            value={scrubTime !== null ? Math.round(scrubTime * 10) / 10 : previewStart}
            onChange={(e) => setPreviewStart(Number(e.target.value))}
          />
        </label>
        {/* One button, as Space: play, or stop what plays. */}
        <button className="small-button preview-play" onClick={() => toggle.current()} disabled={loading} title={t.preview.spaceHint}>
          {loading ? t.preview.loading : liveCursor !== null ? t.preview.stop : t.preview.play}
        </button>
        {/* What plays during "Écouter": any mix of the three -- one block, on
            a line of its own when the row is too narrow. */}
        <span className="preview-hear">
          <span className="preview-listen-label">{t.preview.hear}</span>
          {(
            [
              [t.preview.reference, refMuted, setRefMuted, refGainRef],
              [t.preview.hearCandidate, candOriginalMuted, setCandOriginalMuted, candOriginalGainRef],
              [t.preview.hearResult, candMuted, setCandMuted, candGainRef],
            ] as const
          ).map(([label, muted, setMuted, gain]) => (
            <label key={label}>
              <input
                type="checkbox"
                checked={!muted}
                onChange={() => {
                  // At once on what plays, and for the next clip.
                  if (gain.current) gain.current.gain.value = muted ? 1 : 0;
                  setMuted(!muted);
                }}
              />
              {label}
            </label>
          ))}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
