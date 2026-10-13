// A track's peaks (min and max per bucket, -1..1): fetched once for the
// whole track (TrackPreview's FULL_TRACK_BUCKETS), then cut down to what a
// waveform shows -- the zoomed waveforms and the whole-track navigator.

// Fetched once per track, whole-file, so every zoom/pan afterwards is a pure
// client-side resample (see resamplePeaks) instead of a network round trip;
// also what the background prefetch (prefetch.ts) asks the engine to draw
// ahead. Kept at this: the navigator redraws all of them on every pan, and
// 120000 made navigation visibly lag. The waveform gets coarse near the
// MIN_VIEW_DURATION_S zoom floor, an accepted trade-off.
export const FULL_TRACK_BUCKETS = 20000;

export interface PeaksData {
  min: number[];
  max: number[];
  dataStart: number;
  dataEnd: number;
}

export interface FullPeaks {
  min: number[];
  max: number[];
}

/** Min/max of the whole-track peaks over time range [t0, t1). */
export function peakRange(full: FullPeaks, fullDuration: number, t0: number, t1: number): [number, number] | null {
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
export function resamplePeaks(full: FullPeaks, fullDuration: number, viewStart: number, viewEnd: number, outBuckets: number): PeaksData {
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
