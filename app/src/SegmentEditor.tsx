import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SegmentOut } from "./api";
import {
  LOW_CONFIDENCE_THRESHOLD,
  describeJump,
  formatOffsetMs,
  formatTime,
  offsetTicks,
  segmentOffsetLabel,
} from "./SegmentChart";
import { InfoTip } from "./InfoTip";
import { type TimeView, WHEEL_ZOOM_IN_FACTOR, WHEEL_ZOOM_OUT_FACTOR, useWheel, zoomView } from "./timeView";
import { TrackPreview, type TrackPreviewHandle } from "./TrackPreview";
import { useElementSize } from "./useElementSize";
import "./SegmentEditor.css";

// The chart is drawn at the size its box actually gets (measured), so its
// text keeps one size on any window (see SegmentChart).
const MIN_CHART_HEIGHT = 160;
// Narrower than this, the editor shows its two columns as tabs.
const NARROW_EDITOR_WIDTH = 1000;
const MARGIN = { top: 20, right: 20, bottom: 32, left: 64 };
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
interface EditorState {
  times: number[];
  offsetStarts: number[];
  offsetEnds: number[];
  confidences: number[];
}

function toEditorState(segments: SegmentOut[]): EditorState {
  return {
    times: [segments[0].start_s, ...segments.map((s) => s.end_s)],
    offsetStarts: segments.map((s) => s.offset_start),
    offsetEnds: segments.map((s) => s.offset_end),
    confidences: segments.map((s) => s.confidence),
  };
}

function toSegments(state: EditorState): SegmentOut[] {
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
function mergeSegment(state: EditorState, i: number): EditorState {
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
const MIN_SPLIT_GAP_S = 0.5;

/** Cut segment `i` in two at time `t`, each half keeping its part of the
 * original line (so a drift stays the same drift). */
function splitSegment(state: EditorState, i: number, t: number): EditorState {
  const t0 = state.times[i];
  const t1 = state.times[i + 1];
  const o0 = state.offsetStarts[i];
  const o1 = state.offsetEnds[i];
  const at = o0 + ((o1 - o0) * (t - t0)) / (t1 - t0);
  const insert = <T,>(arr: T[], index: number, value: T) => [...arr.slice(0, index), value, ...arr.slice(index)];
  return {
    times: insert(state.times, i + 1, t),
    offsetStarts: insert(state.offsetStarts, i + 1, at),
    offsetEnds: insert(state.offsetEnds, i, at),
    confidences: insert(state.confidences, i + 1, state.confidences[i]),
  };
}

// Plenty for an editing session, without growing unbounded.
const MAX_HISTORY = 200;

function sameState(a: EditorState, b: EditorState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the pointer is currently dragging on the chart. */
type Drag =
  | { kind: "boundary"; index: number }
  // A whole segment, up or down: both its ends move together, so a drift keeps its slope.
  | { kind: "segment"; index: number; grabOffset: number; offsetStart: number; offsetEnd: number };

/** "Ignorer les segments peu fiables": repeatedly merges away the first
 * remaining segment under LOW_CONFIDENCE_THRESHOLD (same merge -- absorb
 * into the next segment, or the previous one if it's the last -- a manual
 * "Fusionner" click already does), until none are left below the
 * threshold or only one segment remains. Repeats rather than a single
 * pass because merging shifts every later index and can change which
 * segment is now "last". */
function ignoreLowConfidenceSegments(state: EditorState): EditorState {
  let next = state;
  while (next.confidences.length > 1) {
    const i = next.confidences.findIndex((c) => c < LOW_CONFIDENCE_THRESHOLD);
    if (i === -1) break;
    next = mergeSegment(next, i);
  }
  return next;
}

interface PreviewSource {
  referenceFilePath: string;
  candidateFilePath: string;
  referenceIndex: number;
  trackIndex: number;
  referenceStartTime?: number;
  trackStartTime?: number;
}

export function SegmentEditor({
  segments,
  onSave,
  onClose,
  preview,
}: {
  segments: SegmentOut[];
  onSave: (segments: SegmentOut[]) => void;
  onClose: () => void;
  /** When given, renders the same always-visible waveform comparison as the
   * main analysis view, below the offset chart/table -- fed the *live*
   * edited segments (segmentsPreview), not the original `segments` prop, so
   * dragging a boundary or retyping an offset updates "Résultat final"
   * immediately, before Enregistrer is even clicked -- and clicking the
   * chart moves the playback position, with its marker drawn on the chart. */
  preview?: PreviewSource;
}) {
  const [state, setState] = useState<EditorState>(() => toEditorState(segments));
  // What the editor opened with, for "Réinitialiser".
  const [initialState] = useState(state);
  // Undo history: states before each edit, and the ones undone since.
  const [past, setPast] = useState<EditorState[]>([]);
  const [future, setFuture] = useState<EditorState[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The table cell whose current typing session is already in the history,
  // so typing a value is one undo step, not one per keystroke.
  const historyCellRef = useRef<string | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [frozenRange, setFrozenRange] = useState<[number, number] | null>(null);
  // The stretch of the timeline on screen, shared with the waveforms (null: whole track).
  const [view, setView] = useState<TimeView | null>(null);
  // Set once a drag actually moves, so the click ending it isn't also taken
  // as "move the playback position here".
  const movedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [chartBoxRef, chartBox] = useElementSize<HTMLDivElement>();
  const chartWidth = Math.max(300, chartBox.width || 900);
  const chartHeight = Math.max(MIN_CHART_HEIGHT, chartBox.height || 300);
  const [panelRef, panelSize] = useElementSize<HTMLDivElement>();
  const narrow = preview !== undefined && panelSize.width > 0 && panelSize.width < NARROW_EDITOR_WIDTH;
  const [editorView, setEditorView] = useState<"segments" | "listen">("segments");
  const PLOT_W = chartWidth - MARGIN.left - MARGIN.right;
  const PLOT_H = chartHeight - MARGIN.top - MARGIN.bottom;

  /** Record the current state as the one to come back to on undo. */
  function remember() {
    setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), stateRef.current]);
    setFuture([]);
  }

  function applyEdit(update: (s: EditorState) => EditorState) {
    remember();
    setState(update);
  }

  function restore(next: EditorState) {
    setState(next);
    setDrafts({});
    historyCellRef.current = null;
  }

  function undo() {
    const remaining = [...past];
    let previous = remaining.pop();
    // A drag that never moved left an entry identical to now: skip it.
    while (previous && sameState(previous, state)) previous = remaining.pop();
    setPast(remaining);
    if (!previous) return;
    setFuture((f) => [...f, state]);
    restore(previous);
  }

  function redo() {
    const remaining = [...future];
    const next = remaining.pop();
    if (!next) return;
    setFuture(remaining);
    setPast((p) => [...p, state]);
    restore(next);
  }

  function reset() {
    if (sameState(state, initialState)) return;
    remember();
    restore(initialState);
  }

  // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z), in the table's cells too: their own
  // native undo can't follow values the editor rewrites.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Raw text currently being typed into a numeric cell, keyed by e.g.
  // "offsetStart-2" -- kept separate from `state` (the committed numbers)
  // so an in-progress, not-yet-valid string ("-", "-0.", an empty field)
  // is shown exactly as typed instead of being round-tripped through
  // Number()+toFixed() on every keystroke, which turns "-" into NaN and
  // immediately overwrites it back to something else -- the bug this
  // replaced (typing a negative offset was impossible). Cleared on blur so
  // the field then shows the committed, normalized value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Times in seconds to the millisecond, offsets in milliseconds to a tenth.
  function cellValue(key: string, committed: string): string {
    return key in drafts ? drafts[key] : committed;
  }
  const secondsText = (t: number) => t.toFixed(3);
  const msText = (offset: number) => (offset * 1000).toFixed(1);

  function handleCellChange(key: string, raw: string, commit: (n: number) => void) {
    if (historyCellRef.current !== key) {
      remember();
      historyCellRef.current = key;
    }
    setDrafts((d) => ({ ...d, [key]: raw }));
    const n = parseFloat(raw);
    if (Number.isFinite(n)) commit(n);
  }

  function handleCellBlur(key: string) {
    historyCellRef.current = null;
    setDrafts((d) => {
      if (!(key in d)) return d;
      const next = { ...d };
      delete next[key];
      return next;
    });
  }

  const totalDuration = state.times[state.times.length - 1];
  const offsetsFlat = [...state.offsetStarts, ...state.offsetEnds];
  let minOffset = Math.min(0, ...offsetsFlat);
  let maxOffset = Math.max(0, ...offsetsFlat);
  if (minOffset === maxOffset) {
    minOffset -= 1;
    maxOffset += 1;
  }
  const pad = (maxOffset - minOffset) * 0.15;
  minOffset -= pad;
  maxOffset += pad;
  // Held still while dragging: rescaling under the pointer would make the
  // dragged segment run away from it.
  if (frozenRange) [minOffset, maxOffset] = frozenRange;

  // The stretch on screen, the same as the waveforms' (see TrackPreview's
  // `view`): zooming or panning one moves the other.
  const viewStart = view?.start ?? 0;
  const viewDuration = view?.duration ?? totalDuration;
  const x = (t: number) => (viewDuration > 0 ? ((t - viewStart) / viewDuration) * PLOT_W : 0);
  const xInv = (px: number) => (viewDuration > 0 ? viewStart + (px / PLOT_W) * viewDuration : 0);
  const inView = (px: number) => px >= 0 && px <= PLOT_W;
  // A segment's label sits in the middle of its visible part.
  const labelX = (seg: SegmentOut) => (Math.max(0, x(seg.start_s)) + Math.min(PLOT_W, x(seg.end_s))) / 2;
  const y = (offset: number) => PLOT_H - ((offset - minOffset) / (maxOffset - minOffset)) * PLOT_H;

  function timeFromClientX(clientX: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * chartWidth;
    return xInv(svgX - MARGIN.left);
  }

  function offsetFromClientY(clientY: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    const svgY = ((clientY - rect.top) / rect.height) * chartHeight - MARGIN.top;
    return minOffset + ((PLOT_H - svgY) / PLOT_H) * (maxOffset - minOffset);
  }

  function startDrag(e: React.PointerEvent, next: Drag) {
    // Same fix as WaveformNavigator's drag handle: without this, dragging
    // while the pointer passes over surrounding page text triggers the
    // browser's native text-selection gesture.
    e.preventDefault();
    remember(); // the whole drag is one undo step
    movedRef.current = false;
    setFrozenRange([minOffset, maxOffset]);
    setDragging(next);
  }

  useEffect(() => {
    if (dragging === null) return;
    const drag = dragging;
    const minBound = drag.kind === "boundary" ? state.times[drag.index - 1] + 0.1 : 0;
    const maxBound = drag.kind === "boundary" ? state.times[drag.index + 1] - 0.1 : 0;

    function onMove(ev: PointerEvent) {
      movedRef.current = true;
      if (drag.kind === "boundary") {
        const t = Math.min(maxBound, Math.max(minBound, timeFromClientX(ev.clientX)));
        setState((s) => {
          const times = [...s.times];
          times[drag.index] = t;
          return { ...s, times };
        });
        return;
      }
      // Whole milliseconds: finer than anyone can place by hand anyway.
      const delta = Math.round((offsetFromClientY(ev.clientY) - drag.grabOffset) * 1000) / 1000;
      setState((s) => {
        const offsetStarts = [...s.offsetStarts];
        const offsetEnds = [...s.offsetEnds];
        offsetStarts[drag.index] = drag.offsetStart + delta;
        offsetEnds[drag.index] = drag.offsetEnd + delta;
        return { ...s, offsetStarts, offsetEnds };
      });
    }
    function onUp() {
      setDragging(null);
      setFrozenRange(null);
      // After the click this pointerup may produce (only if it ends on the
      // chart): a drag ending elsewhere must not swallow the next real click.
      setTimeout(() => {
        movedRef.current = false;
      }, 0);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  function updateTime(i: number, value: number) {
    setState((s) => {
      const lo = s.times[i - 1] ?? -Infinity;
      const hi = s.times[i + 1] ?? Infinity;
      if (value <= lo || value >= hi) return s;
      const times = [...s.times];
      times[i] = value;
      return { ...s, times };
    });
  }

  function updateOffset(kind: "start" | "end", i: number, value: number) {
    setState((s) => {
      const key = kind === "start" ? "offsetStarts" : "offsetEnds";
      const arr = [...s[key]];
      arr[i] = value;
      return { ...s, [key]: arr };
    });
  }

  const segmentsPreview = useMemo(() => toSegments(state), [state]);

  const previewRef = useRef<TrackPreviewHandle>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const clipId = useId();

  useWheel(svgRef, (e) => {
    const t = timeFromClientX(e.clientX);
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
    setView(zoomView({ start: viewStart, duration: viewDuration }, factor, t, totalDuration));
  });

  /** Click on the chart (not on a boundary handle): move the playback
   * position there, as a click on a waveform does. */
  function handleChartClick(e: React.MouseEvent<SVGSVGElement>) {
    if (movedRef.current) return;
    if (!preview || (e.target as Element).closest(".boundary-handle")) return;
    const t = timeFromClientX(e.clientX);
    if (t < 0 || t > totalDuration) return;
    previewRef.current?.seekTo(t);
  }

  /** Double-click: cut the segment under the pointer at that time. */
  function handleChartDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if ((e.target as Element).closest(".boundary-handle")) return;
    const t = timeFromClientX(e.clientX);
    const i = state.times.findIndex((start, k) => k < state.times.length - 1 && start < t && t < state.times[k + 1]);
    if (i === -1 || t - state.times[i] < MIN_SPLIT_GAP_S || state.times[i + 1] - t < MIN_SPLIT_GAP_S) return;
    applyEdit((s) => splitSegment(s, i, Math.round(t * 1000) / 1000));
  }

  return (
    <div className="editor-overlay" role="dialog" aria-modal="true">
      <div ref={panelRef} className={`editor-panel${preview ? " editor-panel-wide" : ""}${narrow ? " editor-narrow" : ""}`}>
        <div className="editor-header">
          <h2>
            Corriger manuellement les segments{" "}
            <InfoTip>
              <ul>
                <li>Glisse un segment vers le haut ou le bas pour changer son décalage.</li>
                <li>Glisse une poignée ● pour déplacer une frontière.</li>
                <li>Double-clique sur le graphe pour couper un segment à cet endroit.</li>
                <li>Molette : zoomer ou dézoomer, en même temps que les formes d'onde.</li>
                <li>Un segment en pointillés (⚠) est peu fiable : à vérifier à l'écoute.</li>
                <li>Ctrl+Z / Ctrl+Y : défaire / refaire.</li>
                {preview && <li>Clique sur le graphe pour placer la lecture à cet endroit.</li>}
                <li>Décalage : + = la piste est en retard sur la référence, − = en avance.</li>
              </ul>
            </InfoTip>
          </h2>
          {/* Too narrow for the chart and the preview side by side: one at a time. */}
          {narrow && (
            <div className="view-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={editorView === "segments"}
                className={editorView === "segments" ? "active" : ""}
                onClick={() => setEditorView("segments")}
              >
                Segments
              </button>
              <button
                role="tab"
                aria-selected={editorView === "listen"}
                className={editorView === "listen" ? "active" : ""}
                onClick={() => setEditorView("listen")}
              >
                Écoute
              </button>
            </div>
          )}
          <button className="small-button" onClick={onClose}>
            Annuler
          </button>
        </div>

        <div className="editor-columns">
          <div className={narrow && editorView !== "segments" ? "editor-primary view-hidden" : "editor-primary"}>
            <div className="editor-chart-box" ref={chartBoxRef}>
            <svg
              ref={svgRef}
              className={`editor-chart${preview ? " editor-chart-listenable" : ""}${dragging ? " editor-chart-dragging" : ""}`}
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img"
              onClick={handleChartClick}
              onDoubleClick={handleChartDoubleClick}
            >
              <defs>
                {/* Room above the plot for the boundary handles' circles. */}
                <clipPath id={clipId}>
                  <rect x={0} y={-12} width={PLOT_W} height={PLOT_H + 24} />
                </clipPath>
              </defs>
              <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                {offsetTicks(minOffset, maxOffset).map((v) => (
                  <g key={v}>
                    <line x1={0} y1={y(v)} x2={PLOT_W} y2={y(v)} className={v === 0 ? "zero-line" : "grid-line"} />
                    <text x={-8} y={y(v)} className="axis-label" textAnchor="end" dominantBaseline="middle">
                      {formatOffsetMs(v)}
                    </text>
                  </g>
                ))}

                {Array.from({ length: 6 }, (_, i) => viewStart + (viewDuration * i) / 5).map((t) => (
                  <g key={t}>
                    <line x1={x(t)} y1={0} x2={x(t)} y2={PLOT_H} className="grid-line" />
                    <text x={x(t)} y={PLOT_H + 18} className="axis-label" textAnchor="middle">
                      {formatTime(t)}
                    </text>
                  </g>
                ))}

                <g clipPath={`url(#${clipId})`}>
                {segmentsPreview.map((seg, i) => {
                  const flat = (seg.offset_start + seg.offset_end) / 2;
                  const yStart = seg.is_drift ? y(seg.offset_start) : y(flat);
                  const yEnd = seg.is_drift ? y(seg.offset_end) : y(flat);
                  const isDragged = dragging?.kind === "segment" && dragging.index === i;
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
                      {/* A wide invisible stroke on top: the visible line is too thin to grab. */}
                      <line
                        x1={x(seg.start_s)}
                        y1={yStart}
                        x2={x(seg.end_s)}
                        y2={yEnd}
                        className="segment-hit"
                        onPointerDown={(e) =>
                          startDrag(e, {
                            kind: "segment",
                            index: i,
                            grabOffset: offsetFromClientY(e.clientY),
                            offsetStart: seg.offset_start,
                            offsetEnd: seg.offset_end,
                          })
                        }
                      />
                      <text
                        x={labelX(seg)}
                        y={yStart + (yEnd - yStart) * ((labelX(seg) - x(seg.start_s)) / (x(seg.end_s) - x(seg.start_s) || 1)) - 10}
                        className={isDragged ? "segment-label dragged" : "segment-label"}
                        textAnchor="middle"
                      >
                        {segmentOffsetLabel(seg)}
                        {seg.confidence < LOW_CONFIDENCE_THRESHOLD ? " ⚠" : ""}
                      </text>
                    </g>
                  );
                })}

                {/* What the render does at each jump: cut extra content, or fill missing content with silence. */}
                {segmentsPreview.slice(1).map((seg, k) => {
                  const label = describeJump(seg.offset_start - segmentsPreview[k].offset_end);
                  return (
                    label && (
                      <text key={k} x={x(seg.start_s) + 6} y={PLOT_H - 6} className="jump-label">
                        {label}
                      </text>
                    )
                  );
                })}

                {preview && cursor !== null && inView(x(cursor)) && (
                  <line x1={x(cursor)} y1={0} x2={x(cursor)} y2={PLOT_H} className="playback-cursor" />
                )}
                </g>

                {/* Draggable handles on every *internal* boundary only -- the
                    first (0) and last (total duration) are fixed. */}
                {state.times.slice(1, -1).map((t, idx) => {
                  const i = idx + 1;
                  if (!inView(x(t))) return null;
                  return (
                    <g key={i} className="boundary-handle" onPointerDown={(e) => startDrag(e, { kind: "boundary", index: i })}>
                      <line x1={x(t)} y1={-4} x2={x(t)} y2={PLOT_H + 4} className="boundary-line" />
                      <circle cx={x(t)} cy={-4} r={7} />
                    </g>
                  );
                })}
              </g>
            </svg>
            </div>

            <div className="editor-table-wrap list-scroll">
              <table className="editor-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Début (s)</th>
                    <th>Fin (s)</th>
                    <th title="Décalage au début du segment, en millisecondes">Décal. début (ms)</th>
                    <th title="Décalage à la fin du segment, en millisecondes">Décal. fin (ms)</th>
                    <th>Confiance</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {segmentsPreview.map((seg, i) => (
                    <tr key={i} className={seg.confidence < LOW_CONFIDENCE_THRESHOLD ? "editor-row-low-confidence" : undefined}>
                      <td>{i + 1}</td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={cellValue(`start-${i}`, secondsText(seg.start_s))}
                          disabled={i === 0}
                          onChange={(e) => handleCellChange(`start-${i}`, e.target.value, (n) => updateTime(i, n))}
                          onBlur={() => handleCellBlur(`start-${i}`)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={cellValue(`end-${i}`, secondsText(seg.end_s))}
                          disabled={i === segmentsPreview.length - 1}
                          onChange={(e) => handleCellChange(`end-${i}`, e.target.value, (n) => updateTime(i + 1, n))}
                          onBlur={() => handleCellBlur(`end-${i}`)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={cellValue(`offsetStart-${i}`, msText(seg.offset_start))}
                          onChange={(e) => handleCellChange(`offsetStart-${i}`, e.target.value, (n) => updateOffset("start", i, n / 1000))}
                          onBlur={() => handleCellBlur(`offsetStart-${i}`)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={cellValue(`offsetEnd-${i}`, msText(seg.offset_end))}
                          onChange={(e) => handleCellChange(`offsetEnd-${i}`, e.target.value, (n) => updateOffset("end", i, n / 1000))}
                          onBlur={() => handleCellBlur(`offsetEnd-${i}`)}
                        />
                      </td>
                      <td
                        className={seg.confidence < LOW_CONFIDENCE_THRESHOLD ? "editor-confidence-cell low" : "editor-confidence-cell"}
                        title="À quel point cette détection (décalage et classification dérive/constant) est fiable -- voir engine/segments.py:_segment_confidence. Un score bas vient de fenêtres d'analyse qui ne s'accordent pas entre elles et/ou de trop peu de fenêtres en soutien, pas forcément d'une erreur certaine."
                      >
                        {seg.confidence < LOW_CONFIDENCE_THRESHOLD ? "⚠ " : ""}
                        {Math.round(seg.confidence * 100)}%
                      </td>
                      <td>
                        <button
                          className="small-button"
                          disabled={segmentsPreview.length < 2}
                          title="Fusionne ce segment avec le suivant (ou le précédent si c'est le dernier) -- utile pour retirer un segment parasite."
                          onClick={() => applyEdit((s) => mergeSegment(s, i))}
                        >
                          {i < segmentsPreview.length - 1 ? "Fusionner ↓" : "Fusionner ↑"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {preview && (
            <div className={narrow && editorView !== "listen" ? "editor-preview view-hidden" : "editor-preview"}>
              <TrackPreview
                referenceFilePath={preview.referenceFilePath}
                candidateFilePath={preview.candidateFilePath}
                referenceIndex={preview.referenceIndex}
                trackIndex={preview.trackIndex}
                segments={segmentsPreview}
                referenceStartTime={preview.referenceStartTime ?? 0}
                trackStartTime={preview.trackStartTime ?? 0}
                controller={previewRef}
                onCursorChange={setCursor}
                view={view}
                onViewChange={setView}
              />
            </div>
          )}
        </div>

        <div className="editor-actions">
          <div className="editor-history">
            <button className="small-button" onClick={undo} disabled={past.length === 0} title="Ctrl+Z">
              ↶ Défaire
            </button>
            <button className="small-button" onClick={redo} disabled={future.length === 0} title="Ctrl+Y">
              ↷ Refaire
            </button>
            <button
              className="small-button"
              onClick={reset}
              disabled={sameState(state, initialState)}
              title="Revient aux segments tels qu'à l'ouverture de l'éditeur."
            >
              Réinitialiser
            </button>
          </div>
          <button
            className="small-button"
            disabled={!state.confidences.some((c) => c < LOW_CONFIDENCE_THRESHOLD)}
            title="Fusionne automatiquement chaque segment dont la confiance est sous le seuil avec son voisin (même effet que cliquer sur Fusionner pour chacun) -- ex. une fausse dérive détectée sur des fenêtres d'analyse qui ne s'accordent pas entre elles."
            onClick={() => applyEdit(ignoreLowConfidenceSegments)}
          >
            Ignorer les segments peu fiables
          </button>
          <button
            className="primary-button"
            onClick={() => {
              onSave(segmentsPreview);
              onClose();
            }}
          >
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
