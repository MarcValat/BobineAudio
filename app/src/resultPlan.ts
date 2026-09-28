import type { SegmentOut } from "./api";

/** One segment as the render plays it (mirrors the engine's
 * render.segment_correction_filter): reference span [start, end) is filled
 * from candidate span [candStart, candEnd), stretched to fit, except that
 * candidate audio before `readFrom` -- already played by an earlier segment,
 * or before the track's start -- is left silent instead of replayed. */
export interface ResultSegment {
  start: number;
  end: number;
  candStart: number;
  candEnd: number;
  readFrom: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export function planResult(segments: SegmentOut[]): ResultSegment[] {
  let playedUntil = 0;
  return [...segments]
    .sort((a, b) => a.start_s - b.start_s)
    .map((seg) => {
      const candStart = seg.start_s + seg.offset_start;
      const candEnd = seg.end_s + seg.offset_end;
      const readFrom = Math.max(candStart, playedUntil, 0);
      playedUntil = Math.max(playedUntil, candEnd);
      return { start: seg.start_s, end: seg.end_s, candStart, candEnd, readFrom };
    });
}

function candidateAt(seg: ResultSegment, t: number): number {
  const span = seg.end - seg.start;
  if (span <= 0) return seg.candStart;
  return seg.candStart + ((t - seg.start) * (seg.candEnd - seg.candStart)) / span;
}

function referenceAt(seg: ResultSegment, cand: number): number {
  const candSpan = seg.candEnd - seg.candStart;
  if (candSpan <= 0) return seg.start;
  return seg.start + ((cand - seg.candStart) * (seg.end - seg.start)) / candSpan;
}

/** The candidate spans heard over reference time [t0, t1): what the
 * "Résultat final" waveform draws there (silent parts contribute nothing). */
export function candidateSpansIn(plan: ResultSegment[], t0: number, t1: number, candDuration: number): TimeRange[] {
  const spans: TimeRange[] = [];
  for (const seg of plan) {
    const a = Math.max(t0, seg.start);
    const b = Math.min(t1, seg.end);
    if (b <= a) continue;
    const c0 = Math.max(candidateAt(seg, a), seg.readFrom, 0);
    const c1 = Math.min(candidateAt(seg, b), candDuration);
    if (c1 > c0) spans.push({ start: c0, end: c1 });
  }
  return spans;
}

/** Reference-time stretches the result leaves silent: content the candidate
 * is missing (at a jump, or before its start/after its end). */
export function silentRegions(plan: ResultSegment[], candDuration: number): TimeRange[] {
  const regions: TimeRange[] = [];
  for (const seg of plan) {
    if (seg.readFrom > seg.candStart) {
      regions.push({ start: seg.start, end: Math.min(seg.end, referenceAt(seg, seg.readFrom)) });
    }
    if (seg.candEnd > candDuration) {
      regions.push({ start: Math.max(seg.start, referenceAt(seg, candDuration)), end: seg.end });
    }
  }
  return regions.filter((r) => r.end > r.start);
}

/** Candidate-time stretches the result never plays: content the candidate
 * has in excess (at a jump, or past what the reference covers). */
export function skippedRegions(plan: ResultSegment[], candDuration: number): TimeRange[] {
  const played = plan
    .map((seg) => ({ start: Math.max(0, seg.readFrom), end: Math.min(candDuration, seg.candEnd) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const regions: TimeRange[] = [];
  let cursor = 0;
  for (const r of played) {
    if (r.start > cursor) regions.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < candDuration) regions.push({ start: cursor, end: candDuration });
  return regions;
}
