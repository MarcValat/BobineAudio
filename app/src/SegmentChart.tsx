import type { SegmentOut } from "./api";
import "./SegmentChart.css";

const WIDTH = 760;
const HEIGHT = 140;
const MARGIN = { top: 14, right: 16, bottom: 26, left: 70 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

// A segment below this is flagged in the UI and eligible for "Ignorer les
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
  return delta > 0 ? `${amount} coupés` : `${amount} de silence`;
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
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
  const jumps = segments
    .slice(1)
    .filter((seg, i) => Math.abs(seg.offset_start - segments[i].offset_end) >= JUMP_MIN_S).length;
  const drifts = segments.filter((seg) => seg.is_drift).length;
  const unreliable = segments.filter((seg) => seg.confidence < LOW_CONFIDENCE_THRESHOLD).length;
  const parts = [plural(segments.length, "segment")];
  if (jumps > 0) parts.push(plural(jumps, "saut"));
  if (drifts > 0) parts.push(plural(drifts, "dérive"));
  if (unreliable > 0) parts.push(`${unreliable} peu fiable${unreliable > 1 ? "s" : ""}`);
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
export function SegmentChart({ segments, onEdit }: { segments: SegmentOut[]; onEdit?: () => void }) {
  if (segments.length === 0) return null;

  const totalDuration = segments[segments.length - 1].end_s;
  const offsets = segments.flatMap((s) => [s.offset_start, s.offset_end]);
  let minOffset = Math.min(0, ...offsets);
  let maxOffset = Math.max(0, ...offsets);
  if (minOffset === maxOffset) {
    minOffset -= 1;
    maxOffset += 1;
  }
  const pad = (maxOffset - minOffset) * 0.15;
  minOffset -= pad;
  maxOffset += pad;

  const x = (t: number) => (totalDuration > 0 ? (t / totalDuration) * PLOT_W : 0);
  const y = (offset: number) => PLOT_H - ((offset - minOffset) / (maxOffset - minOffset)) * PLOT_H;

  const timeTicks = 5;
  const timeTickValues = Array.from({ length: timeTicks + 1 }, (_, i) => (totalDuration * i) / timeTicks);

  return (
    <div className="segment-chart">
      {/* aspect-ratio (not just viewBox + CSS height:auto) is needed inside
          a flex container: a flex item's height-from-width-via-aspect-ratio
          isn't reliably resolved from viewBox alone before layout runs,
          which was making this chart render tiny once its parent became a
          flex column (see App.css's analysis-card chain). */}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        role="img"
        aria-label="Décalage en fonction du temps"
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

          {/* segments -- a "constant" segment is drawn perfectly flat (at the
              mean of its start/end offset) rather than connecting the two
              raw values: they're classified constant because they're close
              enough, not because they're bit-for-bit equal, and a visible
              tilt on a segment labelled "constant" reads as a rendering bug
              rather than the measurement noise it actually is. Drift
              segments keep their real slope -- that's the whole point. */}
          {segments.map((seg, i) => {
            const flatOffset = (seg.offset_start + seg.offset_end) / 2;
            const yStart = seg.is_drift ? y(seg.offset_start) : y(flatOffset);
            const yEnd = seg.is_drift ? y(seg.offset_end) : y(flatOffset);
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
      <div className="segment-chart-footer">
        <div className="segment-chart-legend">
          <span className="legend-item">
            <span className="legend-swatch constant" /> constant
          </span>
          <span className="legend-item">
            <span className="legend-swatch drift" /> dérive
          </span>
          {segments.some((seg) => seg.confidence < LOW_CONFIDENCE_THRESHOLD) && (
            <span className="legend-item">
              <span className="legend-swatch low-confidence" /> peu fiable
            </span>
          )}
        </div>
        {onEdit && (
          <button className="small-button" onClick={onEdit}>
            Modifier les segments
          </button>
        )}
      </div>
    </div>
  );
}
