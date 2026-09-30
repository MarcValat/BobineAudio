import { useEffect, useState } from "react";
import type { SegmentOut } from "./api";
import { useElementSize } from "./useElementSize";
import "./SegmentChart.css";
import { t, useT } from "./i18n";

// Drawn at its real on-screen width and a fixed height, so its text stays
// the same size on any window, instead of scaling a fixed picture (too tall
// on a wide window, unreadably small on a narrow one). A bit lower on a
// short window, where the waveforms below need the room.
const HEIGHT = 150;
const COMPACT_HEIGHT = 120;
const SHORT_WINDOW = "(max-height: 850px)";

/** Whether the window is short enough for charts to take less height. */
export function useShortWindow(): boolean {
  const [short, setShort] = useState(() => window.matchMedia(SHORT_WINDOW).matches);
  useEffect(() => {
    const query = window.matchMedia(SHORT_WINDOW);
    const onChange = () => setShort(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return short;
}
const MARGIN = { top: 14, right: 16, bottom: 26, left: 70 };

// A segment below this is flagged in the UI and eligible for "Retirer les
// segments peu fiables" -- see engine/segments.py's _segment_confidence,
// which discounts a segment whose supporting windows don't agree with each
// other and/or a segment built from too few of them. Picked as "clearly
// more discounted than trusted" rather than a statistically derived cutoff
// (confidence itself is a heuristic score, not a calibrated probability):
// a segment scoring under this has already lost at least half its
// agreement and/or sample-size factor.
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

// Offset change at a boundary below which it isn't counted as a jump.
export const JUMP_MIN_S = 0.001;

/** An offset in milliseconds, signed: "+1452 ms", "−36 ms", "+0.4 ms". */
export function formatOffsetMs(seconds: number): string {
  const ms = seconds * 1000;
  const abs = Math.abs(ms);
  const digits = abs < 10 && abs >= 0.05 ? 1 : 0;
  const text = abs.toFixed(digits);
  if (Number(text) === 0) return "0 ms";
  return `${ms < 0 ? "−" : "+"}${text} ms`;
}

/** What the render does at a boundary where the offset changes by `delta`
 * (next segment's start minus this one's end): a rise means the track has
 * extra content there, which is cut; a drop means it's missing some, which
 * is filled with silence. Null when there's no jump. */
export function describeJump(delta: number): string | null {
  if (Math.abs(delta) < JUMP_MIN_S) return null;
  const amount = formatOffsetMs(Math.abs(delta)).slice(1);
  return delta > 0 ? t().chart.cut(amount) : t().chart.silence(amount);
}

/** The offset scale of a chart of these offsets (seconds): always
 * including 0 (the reference), 15% of room above and below. */
export function offsetRange(offsets: number[]): [number, number] {
  let min = Math.min(0, ...offsets);
  let max = Math.max(0, ...offsets);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.15;
  return [min - pad, max + pad];
}

/** The offsets a segment's line is drawn at, start and end. A constant
 * segment is drawn perfectly flat, at the mean of its two offsets: it's
 * classified constant because they're close enough, not bit-for-bit equal,
 * and a visible tilt on a segment labelled "constant" reads as a rendering
 * bug rather than the measurement noise it is. A drift keeps its real
 * slope -- that's the whole point. */
export function drawnOffsets(seg: SegmentOut): [number, number] {
  if (seg.is_drift) return [seg.offset_start, seg.offset_end];
  const flat = (seg.offset_start + seg.offset_end) / 2;
  return [flat, flat];
}

/** Round tick values covering [min, max] (seconds), about `target` of them. */
export function offsetTicks(min: number, max: number, target = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const raw = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

/** A segment's offset label: its value, or both ends for a drift. */
export function segmentOffsetLabel(seg: SegmentOut): string {
  if (seg.is_drift) return `${formatOffsetMs(seg.offset_start)} → ${formatOffsetMs(seg.offset_end)}`;
  return formatOffsetMs((seg.offset_start + seg.offset_end) / 2);
}

/** "3 segments · 2 sauts · 1 peu fiable", for a track's analysis header. */
export function describeSegments(segments: SegmentOut[]): string {
  const m = t().chart;
  const jumps = segments
    .slice(1)
    .filter((seg, i) => Math.abs(seg.offset_start - segments[i].offset_end) >= JUMP_MIN_S).length;
  const drifts = segments.filter((seg) => seg.is_drift).length;
  const unreliable = segments.filter((seg) => seg.confidence < LOW_CONFIDENCE_THRESHOLD).length;
  const parts = [m.segments(segments.length)];
  if (jumps > 0) parts.push(m.jumps(jumps));
  if (drifts > 0) parts.push(m.drifts(drifts));
  if (unreliable > 0) parts.push(m.unreliableCount(unreliable));
  return parts.join(" · ");
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

/**
 * A hand-rolled SVG offset-vs-time chart -- no charting library needed for
 * something this simple, and it keeps the GUI's dependency footprint small.
 * Each segment is drawn as a line from (start_s, offset_start) to (end_s,
 * offset_end): flat for a constant-offset segment, sloped for drift -- the
 * same geometry `render.segment_correction_filter` uses to compute the
 * correction, made visible.
 */
/** `fill`: take all the height its container gives it (a tab of its own)
 * instead of its usual fixed one. */
export function SegmentChart({ segments, fill = false }: { segments: SegmentOut[]; fill?: boolean }) {
  const tr = useT();
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const compact = useShortWindow();

  if (segments.length === 0) return null;
  const width = Math.max(200, box.width || 760);
  const height = fill ? Math.max(COMPACT_HEIGHT, box.height || HEIGHT) : compact ? COMPACT_HEIGHT : HEIGHT;
  const PLOT_W = width - MARGIN.left - MARGIN.right;
  const PLOT_H = height - MARGIN.top - MARGIN.bottom;

  const totalDuration = segments[segments.length - 1].end_s;
  const [minOffset, maxOffset] = offsetRange(segments.flatMap((s) => [s.offset_start, s.offset_end]));

  const x = (t: number) => (totalDuration > 0 ? (t / totalDuration) * PLOT_W : 0);
  const y = (offset: number) => PLOT_H - ((offset - minOffset) / (maxOffset - minOffset)) * PLOT_H;

  const timeTicks = 5;
  const timeTickValues = Array.from({ length: timeTicks + 1 }, (_, i) => (totalDuration * i) / timeTicks);

  return (
    <div className={fill ? "segment-chart segment-chart-fill" : "segment-chart"}>
      <div className="segment-chart-box" ref={boxRef} style={fill ? undefined : { height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={tr.chart.ariaLabel}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* offset scale, with the zero line standing out */}
          {offsetTicks(minOffset, maxOffset, 3).map((v) => (
            <g key={v}>
              <line x1={0} y1={y(v)} x2={PLOT_W} y2={y(v)} className={v === 0 ? "zero-line" : "grid-line"} />
              <text x={-8} y={y(v)} className="axis-label" textAnchor="end" dominantBaseline="middle">
                {formatOffsetMs(v)}
              </text>
            </g>
          ))}

          {/* segment boundaries + time axis */}
          {timeTickValues.map((t) => (
            <g key={t}>
              <line x1={x(t)} y1={0} x2={x(t)} y2={PLOT_H} className="grid-line" />
              <text x={x(t)} y={PLOT_H + 16} className="axis-label" textAnchor="middle">
                {formatTime(t)}
              </text>
            </g>
          ))}

          {/* segments (see drawnOffsets) */}
          {segments.map((seg, i) => {
            const [yStart, yEnd] = drawnOffsets(seg).map(y);
            return (
              <g key={i}>
                <line
                  x1={x(seg.start_s)}
                  y1={yStart}
                  x2={x(seg.end_s)}
                  y2={yEnd}
                  className={`segment-line ${seg.is_drift ? "drift" : "constant"}${
                    seg.confidence < LOW_CONFIDENCE_THRESHOLD ? " low-confidence" : ""
                  }`}
                />
                <text
                  x={(x(seg.start_s) + x(seg.end_s)) / 2}
                  y={(yStart + yEnd) / 2 - 8}
                  className="segment-label"
                  textAnchor="middle"
                >
                  {segmentOffsetLabel(seg)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      </div>
      <div className="segment-chart-footer">
        <div className="segment-chart-legend">
          <span className="legend-item">
            <span className="legend-swatch constant" /> {tr.chart.constant}
          </span>
          <span className="legend-item">
            <span className="legend-swatch drift" /> {tr.chart.drift}
          </span>
          {segments.some((seg) => seg.confidence < LOW_CONFIDENCE_THRESHOLD) && (
            <span className="legend-item">
              <span className="legend-swatch low-confidence" /> {tr.chart.unreliable}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
