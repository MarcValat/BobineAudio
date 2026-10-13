import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** The stretch of the timeline on screen, shared by the waveforms and the
 * segment editor's chart so zooming or panning either moves both. */
export interface TimeView {
  start: number;
  duration: number;
}

// Close enough to place a boundary or check a jump by eye (the waveforms
// themselves get coarse this close, see TrackPreview's FULL_TRACK_BUCKETS).
export const MIN_VIEW_DURATION_S = 5;

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

/** `view` moved by `delta` seconds, within [0, total]. */
export function panView(view: TimeView, delta: number, total: number): TimeView {
  return { start: Math.max(0, Math.min(Math.max(0, total - view.duration), view.start + delta)), duration: view.duration };
}

// A press that moves less than this is a click, not a drag.
const DRAG_THRESHOLD_PX = 4;

/** The pointer on a timeline (the waveforms, the segment editor's chart):
 * - a click puts the position there (`onSeek`, the marker glides there);
 * - a left drag moves the position with the pointer (`onScrub` as it goes,
 *   `onScrubEnd` where it's let go -- playback restarts there only then);
 * - a middle-button drag moves the view (`onPan`, by a share of the
 *   element's width: the caller turns it into seconds).
 * `timeAt` turns a pointer's x into a time; `skip`: presses this leaves to
 * the element under the pointer (the editor's handles). Returns the
 * element's onPointerDown, and its onMouseDown (it stops the middle
 * button's autoscroll). */
export function useTimelinePointer(
  ref: RefObject<Element | null>,
  handlers: {
    timeAt: (clientX: number) => number;
    onSeek: (time: number) => void;
    onScrub: (time: number) => void;
    onScrubEnd: (time: number) => void;
    onPan: (share: number) => void;
    skip?: (target: Element) => boolean;
  },
) {
  const latest = useRef(handlers);
  latest.current = handlers;

  function follow(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) {
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("timeline-panning");
      onUp(e);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (latest.current.skip?.(e.target as Element)) return;
    if (e.button === 1) {
      e.preventDefault();
      let lastX = e.clientX;
      document.documentElement.classList.add("timeline-panning");
      follow(
        (ev) => {
          const width = ref.current?.getBoundingClientRect().width ?? 0;
          if (width > 0) latest.current.onPan(-(ev.clientX - lastX) / width);
          lastX = ev.clientX;
        },
        () => {},
      );
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    let dragging = false;
    follow(
      (ev) => {
        if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        latest.current.onScrub(latest.current.timeAt(ev.clientX));
      },
      (ev) => {
        const t = latest.current.timeAt(ev.clientX);
        if (dragging) latest.current.onScrubEnd(t);
        else latest.current.onSeek(t);
      },
    );
  }

  return {
    onPointerDown,
    onMouseDown: (e: ReactMouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
  };
}
