import type { SegmentOut } from "./api";
import { LOW_CONFIDENCE_THRESHOLD } from "./SegmentChart";

// The segment editor's edits (SegmentEditor), as pure functions of its state.

// Must match engine/src/syncaudio/segments.py's _DRIFT_EPS_S: the editor
// recomputes is_drift live as the user edits offset values (rather than
// trusting the segments' original is_drift, which goes stale the moment
// any value changes), and a mismatched threshold here would relabel a
// segment the backend classified as constant the moment it's opened for
// editing -- exactly the bug this comment replaced.
const DRIFT_EPS_S = 0.2;

/** The editable form of a segment list: N+1 boundary times (shared between
 * consecutive segments, so dragging or typing one can never open a gap or
 * an overlap) plus each segment's own two offset values and its original
 * detection confidence (informational only past this point -- editing a
 * segment's own offsets doesn't change how much the *original* detection
 * should have been trusted, so this is never recomputed, just carried
 * along and merged like the other per-segment fields). */
export interface EditorState {
  times: number[];
  offsetStarts: number[];
  offsetEnds: number[];
  confidences: number[];
}

export function toEditorState(segments: SegmentOut[]): EditorState {
  return {
    times: [segments[0].start_s, ...segments.map((s) => s.end_s)],
    offsetStarts: segments.map((s) => s.offset_start),
    offsetEnds: segments.map((s) => s.offset_end),
    confidences: segments.map((s) => s.confidence),
  };
}

export function toSegments(state: EditorState): SegmentOut[] {
  return state.offsetStarts.map((offset_start, i) => {
    const offset_end = state.offsetEnds[i];
    return {
      start_s: state.times[i],
      end_s: state.times[i + 1],
      offset_start,
      offset_end,
      is_drift: Math.abs(offset_end - offset_start) > DRIFT_EPS_S,
      confidence: state.confidences[i],
    };
  });
}

/** Merge segment `i` into neighbour `j`'s slot (next, or previous if `i` is
 * the last segment) -- segment `i` is discarded entirely and `j`'s own
 * offset_start/offset_end now stretch across the combined time range. Used
 * for both "merge with neighbour" and "delete a spurious segment": deleting
 * only makes sense if the survivor's characteristics -- not a blend with
 * the one being removed -- are what cover the freed-up span, otherwise a
 * bad detection right at a file's tail (say) can never actually be
 * cancelled, just diluted (this was previously taking offset_start from
 * whichever segment has the lower index and offset_end from whichever has
 * the higher one, regardless of which was `i` -- for a backward merge that
 * kept exactly the *wrong* half of each). */
export function mergeSegment(state: EditorState, i: number): EditorState {
  const mergeWithNext = i < state.offsetStarts.length - 1;
  const j = mergeWithNext ? i + 1 : i - 1;
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return {
    times: [...state.times.slice(0, lo + 1), ...state.times.slice(hi + 1)],
    offsetStarts: [...state.offsetStarts.slice(0, lo), state.offsetStarts[j], ...state.offsetStarts.slice(hi + 1)],
    offsetEnds: [...state.offsetEnds.slice(0, lo), state.offsetEnds[j], ...state.offsetEnds.slice(hi + 1)],
    confidences: [...state.confidences.slice(0, lo), state.confidences[j], ...state.confidences.slice(hi + 1)],
  };
}

// A cut closer than this to a segment's edge would leave a sliver no
// detection could support.
export const MIN_SPLIT_GAP_S = 0.5;

/** Cut segment `i` in two at time `t`, each half keeping its part of the
 * original line (so a drift stays the same drift). */
export function splitSegment(state: EditorState, i: number, t: number): EditorState {
  const t0 = state.times[i];
  const t1 = state.times[i + 1];
  const o0 = state.offsetStarts[i];
  const o1 = state.offsetEnds[i];
  const at = o0 + ((o1 - o0) * (t - t0)) / (t1 - t0);
  const insert = <T>(arr: T[], index: number, value: T) => [...arr.slice(0, index), value, ...arr.slice(index)];
  return {
    times: insert(state.times, i + 1, t),
    offsetStarts: insert(state.offsetStarts, i + 1, at),
    offsetEnds: insert(state.offsetEnds, i, at),
    confidences: insert(state.confidences, i + 1, state.confidences[i]),
  };
}

export function sameState(a: EditorState, b: EditorState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "Retirer les segments peu fiables": repeatedly merges away the first
 * remaining segment under LOW_CONFIDENCE_THRESHOLD (same merge -- absorb
 * into the next segment, or the previous one if it's the last -- a manual
 * "Retirer" click already does), until none are left below the
 * threshold or only one segment remains. Repeats rather than a single
 * pass because merging shifts every later index and can change which
 * segment is now "last". */
export function ignoreLowConfidenceSegments(state: EditorState): EditorState {
  let next = state;
  while (next.confidences.length > 1) {
    const i = next.confidences.findIndex((c) => c < LOW_CONFIDENCE_THRESHOLD);
    if (i === -1) break;
    next = mergeSegment(next, i);
  }
  return next;
}
