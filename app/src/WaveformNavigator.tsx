import { useEffect, useRef, useState } from "react";
import { peaksToPath } from "./Waveform";
import "./Waveform.css";

const WIDTH = 860;
const HEIGHT = 30;
// Wide enough to always grab, even when the current view is a tiny sliver
// of a long track -- a window narrower than this would be near-impossible
// to click/drag precisely.
const MIN_WINDOW_PX = 6;

interface WaveformNavigatorProps {
  duration: number;
  viewStart: number;
  viewDuration: number;
  peaksMin: number[] | null;
  peaksMax: number[] | null;
  /** Pan only -- the highlighted window's *width* always mirrors the
   * current zoom (viewDuration), set elsewhere (the zoom buttons/wheel);
   * this only ever moves where it starts. */
  onNavigate: (viewStart: number) => void;
}

/** A whole-track overview bar below the three zoomed waveforms: drag the
 * highlighted window to pan without a dezoom-then-rezoom round trip, or
 * click anywhere else on the bar to jump the view there directly. Kept as
 * its own tiny component (not folded into Waveform.tsx) since it shows the
 * *whole* track on a fixed axis, not the shared zoomable [viewStart,
 * viewStart+viewDuration] window the three real waveforms scroll through. */
export function WaveformNavigator({ duration, viewStart, viewDuration, peaksMin, peaksMax, onNavigate }: WaveformNavigatorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Anchors the drag to where it *started*, not the live pointer position,
  // so the window pans by exactly the pointer's movement instead of
  // snapping its near edge to the cursor on the first pixel of movement.
  const [drag, setDrag] = useState<{ startClientX: number; startViewStart: number } | null>(null);

  const clampStart = (s: number) => Math.max(0, Math.min(Math.max(0, duration - viewDuration), s));
  const timeToX = (t: number) => (duration > 0 ? (t / duration) * WIDTH : 0);

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !drag) return;
      const deltaFrac = (e.clientX - drag.startClientX) / rect.width;
      onNavigate(clampStart(drag.startViewStart + deltaFrac * duration));
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  function handleWindowPointerDown(e: React.PointerEvent<SVGRectElement>) {
    // Without this, dragging the window while the pointer passes over
    // surrounding page text triggers the browser's native text-selection
    // gesture -- harmless functionally (reported: no actual bug in the
    // pan itself), but distracting since it visibly highlights text.
    e.preventDefault();
    e.stopPropagation();
    setDrag({ startClientX: e.clientX, startViewStart: viewStart });
  }

  function handleBackgroundClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current || duration <= 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onNavigate(clampStart(frac * duration - viewDuration / 2));
  }

  const path = peaksMin && peaksMax ? peaksToPath(peaksMin, peaksMax, 0, WIDTH, HEIGHT) : "";
  const winX0 = Math.max(0, timeToX(viewStart));
  const winX1raw = Math.min(WIDTH, timeToX(viewStart + viewDuration));
  const winX1 = Math.max(winX1raw, winX0 + MIN_WINDOW_PX);

  return (
    <div className="waveform-navigator">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="waveform-navigator-svg"
        onClick={handleBackgroundClick}
        role="img"
        aria-label="Navigation dans la piste entière"
      >
        <line x1={0} y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="waveform-zero" />
        {path && <path d={path} className="waveform-navigator-path" />}
        <rect
          x={winX0}
          y={0}
          width={winX1 - winX0}
          height={HEIGHT}
          className="waveform-navigator-window"
          onPointerDown={handleWindowPointerDown}
          onClick={(e) => e.stopPropagation()}
        />
      </svg>
    </div>
  );
}
