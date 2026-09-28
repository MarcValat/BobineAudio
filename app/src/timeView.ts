import { useEffect, useRef, type RefObject } from "react";

/** The stretch of the timeline on screen, shared by the waveforms and the
 * segment editor's chart so zooming or panning either moves both. */
export interface TimeView {
  start: number;
  duration: number;
}

// Below this, there's nothing more to see: the panel isn't wide enough for
// finer detail to matter, and the diff highlight is computed analytically
// anyway, not read off the waveform pixel by pixel.
export const MIN_VIEW_DURATION_S = 20;

export const WHEEL_ZOOM_IN_FACTOR = 0.85;
export const WHEEL_ZOOM_OUT_FACTOR = 1 / WHEEL_ZOOM_IN_FACTOR;

/** `view` zoomed by `factor` (< 1 in, > 1 out) keeping `centerTime` at the
 * same place on screen, within [0, total]. */
export function zoomView(view: TimeView, factor: number, centerTime: number, total: number): TimeView {
  const duration = Math.max(Math.min(MIN_VIEW_DURATION_S, total), Math.min(total, view.duration * factor));
  const frac = view.duration > 0 ? (centerTime - view.start) / view.duration : 0.5;
  const start = Math.max(0, Math.min(Math.max(0, total - duration), centerTime - frac * duration));
  return { start, duration };
}

/** Calls `onWheel` for wheel events on `ref`'s element, with the page's own
 * scrolling blocked. React registers wheel listeners as passive, where
 * preventDefault() is ignored: the surrounding panel would scroll while
 * zooming. */
export function useWheel(ref: RefObject<Element | null>, onWheel: (e: WheelEvent) => void): void {
  const handler = useRef(onWheel);
  handler.current = onWheel;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (e: Event) => {
      e.preventDefault();
      handler.current(e as WheelEvent);
    };
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [ref]);
}
