import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { formatTime } from "./SegmentChart";
import { WHEEL_ZOOM_IN_FACTOR, WHEEL_ZOOM_OUT_FACTOR, useTimelinePointer, useWheel } from "./timeView";
import "./Waveform.css";
import { t } from "./i18n";

const WIDTH = 860;
const HEIGHT = 56;

export interface HighlightRegion {
  start: number;
  end: number;
  kind: "removed" | "added";
}

interface WaveformProps {
  viewStart: number;
  viewDuration: number;
  peaksMin: number[] | null;
  peaksMax: number[] | null;
  /** The [dataStart, dataEnd] sub-range (same axis as viewStart) that
   * peaksMin/peaksMax actually cover -- can be narrower than the full view
   * when part of it falls outside the track's real bounds (e.g. the padded
   * side of an offset-shifted view). Outside this range, nothing is drawn. */
  dataStart: number;
  dataEnd: number;
  cursor: number | null;
  /** The marker glides to a new position (a click) rather than jumping;
   * off while playing, where it moves every frame. */
  cursorGlide?: boolean;
  /** A click: the position goes there (see useTimelinePointer). */
  onSeek: (time: number) => void;
  /** A left drag: the position follows the pointer, then is let go. */
  onScrub: (time: number) => void;
  onScrubEnd: (time: number) => void;
  /** A middle-button drag: the view moves by this share of its length. */
  onPan: (share: number) => void;
  /** Zoom by `factor` (< 1 in, > 1 out) keeping `centerTime` anchored --
   * the caller (TrackPreview) applies it to all three waveforms at once. */
  onZoom: (factor: number, centerTime: number) => void;
  highlights?: HighlightRegion[];
  label: string;
  /** Beside the label, on the right: what its colors mean, a value. */
  labelExtra?: ReactNode;
  className?: string;
}

/** Whether a playback marker may glide to its new place this render: asked
 * (`glide`), and what it's drawn against (`layout`: the view's start and
 * length, a chart's width) hasn't changed since the last render -- a zoom,
 * a pan or a resize moves the marker with everything else, at once, not
 * trailing behind. (The waveforms and the segment editor's chart.) */
export function useMarkerGlide(glide: boolean, ...layout: number[]): boolean {
  const last = useRef(layout);
  const steady = layout.length === last.current.length && layout.every((v, i) => v === last.current[i]);
  useEffect(() => {
    last.current = layout;
  });
  return glide && steady;
}

// In viewBox units, about as many pixels at the waveform's usual size.
const MIN_HIGHLIGHT_W = 3;


/** Exported for WaveformNavigator.tsx's mini overview waveform -- same peak
 * data, just drawn over the whole-track axis instead of the current
 * [viewStart, viewStart+viewDuration] window. */
export function peaksToPath(min: number[], max: number[], x0: number, x1: number, height: number): string {
  const n = min.length;
  if (n === 0 || x1 <= x0) return "";
  const xStep = (x1 - x0) / n;
  const mid = height / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = (x0 + (i + 0.5) * xStep).toFixed(1);
    top.push(`${x},${(mid - max[i] * mid).toFixed(1)}`);
    bottom.push(`${x},${(mid - min[i] * mid).toFixed(1)}`);
  }
  bottom.reverse();
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}

/** A hand-rolled peak waveform (no charting library) over a caller-controlled
 * [viewStart, viewStart+viewDuration] window -- click-to-seek, an optional
 * moving playhead, and optional red/green diff-style highlight regions. */
export function Waveform({
  viewStart,
  viewDuration,
  peaksMin,
  peaksMax,
  dataStart,
  dataEnd,
  cursor,
  cursorGlide = false,
  onSeek,
  onScrub,
  onScrubEnd,
  onPan,
  onZoom,
  highlights,
  label,
  labelExtra,
  className,
}: WaveformProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const timeToX = (t: number) => (viewDuration > 0 ? ((t - viewStart) / viewDuration) * WIDTH : 0);

  const pointer = useTimelinePointer(svgRef, {
    timeAt: (clientX) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const frac = rect && rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return viewStart + Math.max(0, Math.min(1, frac)) * viewDuration;
    },
    onSeek,
    onScrub,
    onScrubEnd,
    onPan,
  });

  /** Scroll up zooms in, scroll down zooms out, anchored under the cursor
   * (the same convention as a map), without scrolling the surrounding panel. */
  useWheel(svgRef, (e) => {
    if (!svgRef.current || viewDuration <= 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const centerTime = viewStart + Math.max(0, Math.min(1, frac)) * viewDuration;
    onZoom(e.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR, centerTime);
  });

  const dataX0 = Math.max(0, timeToX(dataStart));
  const dataX1 = Math.min(WIDTH, timeToX(dataEnd));
  // Not again at every render: the playhead moving renders it each frame.
  const path = useMemo(
    () => (peaksMin && peaksMax ? peaksToPath(peaksMin, peaksMax, dataX0, dataX1, HEIGHT) : ""),
    [peaksMin, peaksMax, dataX0, dataX1],
  );

  // A cut or inserted silence of tens of ms is a fraction of a pixel on a
  // whole-episode view: too thin to see, and hidden under the waveform.
  // Those get a minimum width, centred on the real spot, drawn over the
  // waveform, so every change stays visible at any zoom.
  const wideHighlights: { x0: number; x1: number; kind: HighlightRegion["kind"] }[] = [];
  const markers: { x0: number; x1: number; kind: HighlightRegion["kind"] }[] = [];
  for (const h of highlights ?? []) {
    const x0 = timeToX(h.start);
    const x1 = timeToX(h.end);
    if (x1 < 0 || x0 > WIDTH) continue;
    if (x1 - x0 >= MIN_HIGHLIGHT_W) {
      wideHighlights.push({ x0: Math.max(0, x0), x1: Math.min(WIDTH, x1), kind: h.kind });
    } else {
      const mid = (x0 + x1) / 2;
      markers.push({ x0: mid - MIN_HIGHLIGHT_W / 2, x1: mid + MIN_HIGHLIGHT_W / 2, kind: h.kind });
    }
  }

  const cursorX = cursor !== null ? timeToX(cursor) : null;
  const showCursor = cursorX !== null && cursorX >= 0 && cursorX <= WIDTH;
  const glide = useMarkerGlide(cursorGlide, viewStart, viewDuration);

  const timeTicks = 5;
  const tickValues = Array.from({ length: timeTicks + 1 }, (_, i) => viewStart + (viewDuration * i) / timeTicks);

  return (
    <div className={`waveform ${className ?? ""}`}>
      <div className="waveform-label">
        <span className="waveform-label-name">{label}</span>
        {labelExtra && <span className="waveform-label-extra">{labelExtra}</span>}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="waveform-svg"
        onPointerDown={pointer.onPointerDown}
        onMouseDown={pointer.onMouseDown}
        role="img"
        aria-label={t().preview.waveform(label)}
      >
        <line x1={0} y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="waveform-zero" />
        {wideHighlights.map((h, i) => (
          <rect key={i} x={h.x0} y={0} width={h.x1 - h.x0} height={HEIGHT} className={`waveform-highlight ${h.kind}`} />
        ))}
        {path && <path d={path} className="waveform-path" />}
        {markers.map((h, i) => (
          <rect
            key={i}
            x={h.x0}
            y={0}
            width={h.x1 - h.x0}
            height={HEIGHT}
            className={`waveform-highlight waveform-highlight-marker ${h.kind}`}
          />
        ))}
        {showCursor && (
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={HEIGHT}
            className={`waveform-cursor${glide ? " glide" : ""}`}
            style={{ transform: `translateX(${cursorX}px)` }}
          />
        )}
      </svg>
      <div className="waveform-ticks">
        {tickValues.map((t, i) => (
          <span key={i}>{formatTime(t)}</span>
        ))}
      </div>
    </div>
  );
}
