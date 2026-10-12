import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SegmentOut } from "./api";
import {
  LOW_CONFIDENCE_THRESHOLD,
  describeJump,
  drawnOffsets,
  formatOffsetMs,
  offsetRange,
  formatTime,
  offsetTicks,
  segmentOffsetLabel,
  SegmentLegend,
} from "./SegmentChart";
import { ConfidenceGauge } from "./ConfidenceGauge";
import { InfoTip } from "./InfoTip";
import { RedoEditIcon, UndoIcon } from "./icons";
import { ViewSwitch, type AnalysisView } from "./Detail";
import { type TimeView, WHEEL_ZOOM_IN_FACTOR, WHEEL_ZOOM_OUT_FACTOR, useTimelinePointer, useWheel, zoomView } from "./timeView";
import { TrackPreview, type TrackPreviewHandle } from "./TrackPreview";
import { useMarkerGlide } from "./Waveform";
import { useElementSize } from "./useElementSize";
import {
  MIN_SPLIT_GAP_S,
  ignoreLowConfidenceSegments,
  mergeSegment,
  sameState,
  splitSegment,
  toEditorState,
  toSegments,
  type EditorState,
} from "./segmentEdits";
import "./SegmentEditor.css";
import { Dialog, DialogHeader } from "./Dialog";
import { useT } from "./i18n";

// The chart is drawn at the size its box actually gets (measured), so its
// text keeps one size on any window (see SegmentChart).
const MIN_CHART_HEIGHT = 160;
// Narrower than this, the editor shows its two columns as tabs.
const NARROW_EDITOR_WIDTH = 1150;
const MARGIN = { top: 20, right: 20, bottom: 32, left: 64 };
// Plenty for an editing session, without growing unbounded.
const MAX_HISTORY = 200;

/** What the pointer is currently dragging on the chart. */
type Drag =
  | { kind: "boundary"; index: number }
  // A whole segment, up or down: both its ends move together, so a drift keeps its slope.
  | { kind: "segment"; index: number; grabOffset: number; offsetStart: number; offsetEnd: number };

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
  subtitle,
  onSave,
  onClose,
  preview,
}: {
  segments: SegmentOut[];
  /** What's being corrected: "file · track", beside the title. */
  subtitle?: string;
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
  const t = useT();
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
  const [cursor, setCursor] = useState<number | null>(null);
  // Playing: the marker moves every frame (no glide then).
  const [playing, setPlaying] = useState(false);
  // Set once a drag actually moves, so the click ending it isn't also taken
  // as "move the playback position here".
  const movedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [chartBoxRef, chartBox] = useElementSize<HTMLDivElement>();
  const chartWidth = Math.max(300, chartBox.width || 900);
  const chartHeight = Math.max(MIN_CHART_HEIGHT, chartBox.height || 300);
  const [panelRef, panelSize] = useElementSize<HTMLDivElement>();
  const narrow = preview !== undefined && panelSize.width > 0 && panelSize.width < NARROW_EDITOR_WIDTH;
  const [editorView, setEditorView] = useState<AnalysisView>("segments");
  // The segment whose "Retirer" button is hovered: shown on the chart, with
  // the neighbour that would take its place.
  const [removalPreview, setRemovalPreview] = useState<number | null>(null);
  // "Annuler" (or Escape) with unsaved changes asks first.
  const [confirmingClose, setConfirmingClose] = useState(false);
  const dirty = !sameState(state, initialState);

  function requestClose() {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }
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
    if (!dirty) return;
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
  // Held still while dragging: rescaling under the pointer would make the
  // dragged segment run away from it.
  const [minOffset, maxOffset] = frozenRange ?? offsetRange([...state.offsetStarts, ...state.offsetEnds]);

  // The stretch on screen, the same as the waveforms' (see TrackPreview's
  // `view`): zooming or panning one moves the other.
  const viewStart = view?.start ?? 0;
  const viewDuration = view?.duration ?? totalDuration;
  const cursorGlide = useMarkerGlide(!playing, viewStart, viewDuration, chartWidth, chartHeight);
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
  // The segment "Retirer" would leave in place of the hovered one and its neighbour.
  const removalGhost =
    removalPreview !== null && removalPreview < segmentsPreview.length && segmentsPreview.length > 1
      ? toSegments(mergeSegment(state, removalPreview))[removalPreview < segmentsPreview.length - 1 ? removalPreview : removalPreview - 1]
      : null;

  const previewRef = useRef<TrackPreviewHandle>(null);
  const clipId = useId();
  // Names the dialog for a screen reader (its title row).
  const titleId = useId();

  useWheel(svgRef, (e) => {
    const t = timeFromClientX(e.clientX);
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
    setView(zoomView({ start: viewStart, duration: viewDuration }, factor, t, totalDuration));
  });

  /** The pointer on the chart, off the handles and the segments (which
   * drag themselves): a click moves the playback position there, a left
   * drag moves it with the pointer, a middle-button drag moves the view --
   * the same as on the waveforms (useTimelinePointer). */
  const chartPointer = useTimelinePointer(svgRef, {
    timeAt: (clientX) => Math.max(0, Math.min(totalDuration, timeFromClientX(clientX))),
    onSeek: (t) => previewRef.current?.seekTo(t),
    onScrub: (t) => previewRef.current?.scrubTo(t),
    onScrubEnd: (t) => previewRef.current?.endScrub(t),
    // A share of the svg's width, the plot being a part of it.
    onPan: (share) => previewRef.current?.pan((share * chartWidth) / PLOT_W),
    skip: (target) => !preview || !!target.closest(".boundary-handle, .segment-hit"),
  });

  /** Double-click: cut the segment under the pointer at that time. */
  function handleChartDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if ((e.target as Element).closest(".boundary-handle")) return;
    const t = timeFromClientX(e.clientX);
    const i = state.times.findIndex((start, k) => k < state.times.length - 1 && start < t && t < state.times[k + 1]);
    if (i === -1 || t - state.times[i] < MIN_SPLIT_GAP_S || state.times[i + 1] - t < MIN_SPLIT_GAP_S) return;
    applyEdit((s) => splitSegment(s, i, Math.round(t * 1000) / 1000));
  }

  return (
    <Dialog
      fill
      labelledBy={titleId}
      onClose={onClose}
      // Escape backs out of the "abandon changes?" question first.
      onEscape={() => (confirmingClose ? setConfirmingClose(false) : requestClose())}
      panelRef={panelRef}
      className={`editor-panel${preview ? " editor-panel-wide" : ""}${narrow ? " editor-narrow" : ""}`}
    >
      <DialogHeader
        id={titleId}
        titleTooltip={subtitle}
        title={
          <>
            {t.editor.title}{" "}
            <InfoTip>
              <ul>
                <li>{t.editor.help.dragSegment}</li>
                <li>{t.editor.help.dragHandle}</li>
                <li>{t.editor.help.split}</li>
                <li>{t.editor.help.wheel}</li>
                <li>{t.editor.help.unreliable}</li>
                <li>{t.editor.help.remove}</li>
                <li>{t.editor.help.undo}</li>
                {preview && <li>{t.editor.help.seek}</li>}
                <li>{t.editor.help.sign}</li>
              </ul>
            </InfoTip>
            {subtitle && <span className="editor-subtitle">{subtitle}</span>}
          </>
        }
      >
        {/* Too narrow for the chart and the preview side by side: one at a time. */}
        {narrow && <ViewSwitch value={editorView} onChange={setEditorView} />}
        {/* What the lines mean, then the question when closing would lose
              edits (Annuler or Escape). */}
        <SegmentLegend unreliable={state.confidences.some((c) => c < LOW_CONFIDENCE_THRESHOLD)} />
        {confirmingClose && (
          <div className="editor-confirm-close" role="alertdialog">
            <span>{t.editor.abandonQuestion}</span>
            <button className="small-button export-cancel" onClick={onClose}>
              {t.editor.abandon}
            </button>
            <button className="small-button" onClick={() => setConfirmingClose(false)}>
              {t.editor.keepEditing}
            </button>
          </div>
        )}
      </DialogHeader>

      <div className="editor-columns">
        <div className={narrow && editorView !== "segments" ? "editor-primary view-hidden" : "editor-primary"}>
          <div className="editor-chart-box" ref={chartBoxRef}>
            <svg
              ref={svgRef}
              className={`editor-chart${preview ? " editor-chart-listenable" : ""}${dragging ? " editor-chart-dragging" : ""}`}
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img"
              aria-label={t.chart.ariaLabel}
              onPointerDown={chartPointer.onPointerDown}
              onMouseDown={chartPointer.onMouseDown}
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
                    const [yStart, yEnd] = drawnOffsets(seg).map(y);
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
                          }${removalPreview === i ? " removal-target" : ""}`}
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
                          className={`segment-label${isDragged ? " dragged" : ""}${seg.confidence < LOW_CONFIDENCE_THRESHOLD ? " low-confidence" : ""}`}
                          textAnchor="middle"
                        >
                          {segmentOffsetLabel(seg)}
                        </text>
                      </g>
                    );
                  })}

                  {/* "Retirer" hovered: what the neighbour would become once stretched over the removed segment. */}
                  {removalGhost && (
                    <line
                      x1={x(removalGhost.start_s)}
                      y1={y(drawnOffsets(removalGhost)[0])}
                      x2={x(removalGhost.end_s)}
                      y2={y(drawnOffsets(removalGhost)[1])}
                      className="segment-line removal-ghost"
                    />
                  )}

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
                    <line
                      x1={0}
                      y1={0}
                      x2={0}
                      y2={PLOT_H}
                      className={`playback-cursor${cursorGlide ? " glide" : ""}`}
                      style={{ transform: `translateX(${x(cursor)}px)` }}
                    />
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
              onCursorChange={(t, isPlaying) => {
                setCursor(t);
                setPlaying(isPlaying);
              }}
              view={view}
              onViewChange={setView}
            />
          </div>
        )}
      </div>

      {/* Under both, across the editor (as the mockup): the segments' values. */}
      <div className="editor-table-wrap list-scroll">
        <table className="editor-table">
          <thead>
            <tr>
              <th>#</th>
              <th>
                {t.editor.start} <span className="th-unit">(s)</span>
              </th>
              <th>
                {t.editor.end} <span className="th-unit">(s)</span>
              </th>
              <th title={t.editor.offsetStartHint}>
                {t.editor.offsetStart} <span className="th-unit">(ms)</span>
              </th>
              <th title={t.editor.offsetEndHint}>
                {t.editor.offsetEnd} <span className="th-unit">(ms)</span>
              </th>
              <th>{t.editor.confidence}</th>
              <th>{t.editor.actions}</th>
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
                    aria-label={t.editor.cell(t.editor.start, i + 1)}
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
                    aria-label={t.editor.cell(t.editor.end, i + 1)}
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
                    aria-label={t.editor.cell(t.editor.offsetStart, i + 1)}
                    value={cellValue(`offsetStart-${i}`, msText(seg.offset_start))}
                    onChange={(e) => handleCellChange(`offsetStart-${i}`, e.target.value, (n) => updateOffset("start", i, n / 1000))}
                    onBlur={() => handleCellBlur(`offsetStart-${i}`)}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={t.editor.cell(t.editor.offsetEnd, i + 1)}
                    value={cellValue(`offsetEnd-${i}`, msText(seg.offset_end))}
                    onChange={(e) => handleCellChange(`offsetEnd-${i}`, e.target.value, (n) => updateOffset("end", i, n / 1000))}
                    onBlur={() => handleCellBlur(`offsetEnd-${i}`)}
                  />
                </td>
                <td className="editor-confidence-cell" title={t.editor.confidenceHint}>
                  <ConfidenceGauge value={seg.confidence} />
                </td>
                <td>
                  <button
                    className="small-button"
                    disabled={segmentsPreview.length < 2}
                    title={
                      segmentsPreview.length < 2
                        ? t.editor.onlySegment
                        : t.editor.removeHint(i + 1, i < segmentsPreview.length - 1 ? i + 2 : i)
                    }
                    onMouseEnter={() => setRemovalPreview(i)}
                    onMouseLeave={() => setRemovalPreview(null)}
                    onFocus={() => setRemovalPreview(i)}
                    onBlur={() => setRemovalPreview(null)}
                    onClick={() => {
                      setRemovalPreview(null);
                      applyEdit((s) => mergeSegment(s, i));
                    }}
                  >
                    {t.common.remove}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="editor-actions">
        <div className="editor-history">
          <button className="with-icon" onClick={undo} disabled={past.length === 0} title="Ctrl+Z">
            <UndoIcon />
            {t.editor.undo}
          </button>
          <button className="with-icon" onClick={redo} disabled={future.length === 0} title="Ctrl+Y">
            <RedoEditIcon />
            {t.editor.redo}
          </button>
          <button onClick={reset} disabled={!dirty} title={t.editor.resetHint}>
            {t.editor.reset}
          </button>
        </div>
        <button
          disabled={!state.confidences.some((c) => c < LOW_CONFIDENCE_THRESHOLD)}
          title={t.editor.removeUnreliableHint}
          onClick={() => applyEdit(ignoreLowConfidenceSegments)}
        >
          {t.editor.removeUnreliable}
        </button>
        {/* Asks first when edits would be lost (in the header). */}
        <button onClick={requestClose} title={t.editor.cancelHint}>
          {t.common.cancel}
        </button>
        <button
          className="primary-button"
          onClick={() => {
            onSave(segmentsPreview);
            onClose();
          }}
        >
          {t.editor.save}
        </button>
      </div>
    </Dialog>
  );
}
