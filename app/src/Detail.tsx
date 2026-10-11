import { useState, type ReactNode } from "react";
import type { SegmentsResponse, SubtitleInfo } from "./api";
import { nextStep, RevealButton, writtenFile, type AnalysisRun, type ExportFields } from "./batchShared";
import { useT } from "./i18n";
import { RedoIcon } from "./icons";
import { InfoTip, Tooltip } from "./InfoTip";
import { LogPanel } from "./LogPanel";
import { basename } from "./paths";
import { PillSwitch } from "./PillSwitch";
import { SegmentChart, SegmentChartPlaceholder } from "./SegmentChart";
import { useElementSize } from "./useElementSize";
import { Dialog, DialogHeader } from "./Dialog";
import { SubtitleChecks } from "./SubtitleChecks";
import { subtitleLabel, subtitleShortLabel, takenByOthers } from "./subtitles";

/** The parts of a list item's detail (Workspace.css), shared by both batch
 * modes: a multitrack file's and a pair's are laid out alike -- a header
 * with the item's next step, a tab per corrected track, its tracks beside
 * its chart, its waveforms and playback, how its export went. */

/** Segments / Écoute: the chart or the waveforms, when there isn't room
 * for both. */
export type AnalysisView = "segments" | "listen";

// Height of the detail's body below which the tracks and chart, and the
// waveforms, are shown one at a time (the Segments / Écoute tabs).
const COMPACT_HEIGHT = 560;

/** The detail's body (`ref`), and whether it's too low for the tracks, the
 * chart and readable waveforms at once: then they're two tabs, the `view`
 * picked; the classes put each part on its tab. */
export function useDetailView() {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [view, setView] = useState<AnalysisView>("listen");
  const compact = size.height > 0 && size.height < COMPACT_HEIGHT;
  return {
    ref,
    compact,
    view,
    setView,
    /** The tracks and the chart: hidden on the Écoute tab, the whole
     * height on the Segments one. `analyzed`: there's a chart (else no tabs). */
    topClass: (analyzed: boolean) =>
      compact && analyzed ? (view === "listen" ? "view-hidden" : "detail-top detail-top-fill") : "detail-top",
    /** The waveforms and playback: hidden on the Segments tab. */
    listenClass: () => (compact && view !== "listen" ? "view-hidden" : "segments-result"),
  };
}

/** The Segments / Écoute switch. */
export function ViewSwitch({ value, onChange }: { value: AnalysisView; onChange: (view: AnalysisView) => void }) {
  const t = useT();
  return (
    <PillSwitch
      className="view-switch"
      label={t.common.view}
      options={[
        ["segments", t.common.segments],
        ["listen", t.common.listen],
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** The detail's title row: the item's name and what it is, then its
 * buttons -- "Réanalyser" (the shown track alone), "Modifier les segments",
 * and its next step -- "Analyser" while some of its tracks aren't
 * analyzed, then its export -- as the gradient button when the item holds
 * the window's next step (`primary`: it's alone in the list; with several,
 * the footer's buttons do). */
export function DetailHeader({
  title,
  titleTooltip,
  meta,
  onReanalyze,
  onEdit,
  editDisabled,
  missing,
  analyzing,
  done,
  exported,
  primary,
  disabled,
  analyzeDisabled = false,
  blockedTitle,
  analyzeTitle,
  exportLabel,
  onAnalyze,
  onExport,
}: {
  title: ReactNode;
  titleTooltip?: string;
  meta?: ReactNode;
  /** The shown track's analysis is over (done or failed): it can be redone. */
  onReanalyze?: () => void;
  /** The shown track is analyzed: its segments can be edited. */
  onEdit?: () => void;
  editDisabled: boolean;
  /** Tracks not analyzed yet (or failed), being analyzed, analyzed. */
  missing: number;
  analyzing: boolean;
  done: number;
  /** Its export is written (and still what it would write). */
  exported: boolean;
  primary: boolean;
  /** Something runs (here or in the other mode): nothing starts. */
  disabled: boolean;
  /** Nothing to analyze it with (no reference, a file that can't be read). */
  analyzeDisabled?: boolean;
  /** Why it's disabled, when it's the other mode working. */
  blockedTitle?: string;
  analyzeTitle: string;
  exportLabel: string;
  onAnalyze: () => void;
  onExport: () => void;
}) {
  const t = useT();
  const next = primary ? nextStep({ analyzing, missing, exportable: done > 0 ? 1 : 0, exported: exported ? 1 : 0 }) : null;
  return (
    <div className="detail-header">
      <div className="detail-title">
        <span className="detail-name" title={titleTooltip}>
          {title}
        </span>
        {meta && <span className="detail-meta">{meta}</span>}
      </div>
      {onReanalyze && (
        <Tooltip text={t.batch.reanalyzeOneHint}>
          <button className="icon-small-button detail-icon-button" disabled={disabled} onClick={onReanalyze} aria-label={t.batch.reanalyzeOne}>
            <RedoIcon />
          </button>
        </Tooltip>
      )}
      {onEdit && (
        <button disabled={editDisabled} onClick={onEdit}>
          {t.common.editSegments}
        </button>
      )}
      {(missing > 0 || analyzing) && (
        <button
          className={next === "analyze" ? "primary-button" : ""}
          disabled={analyzing || disabled || analyzeDisabled}
          title={blockedTitle ?? analyzeTitle}
          onClick={onAnalyze}
        >
          {analyzing ? t.common.analysisRunning : t.multi.analyzeFile}
        </button>
      )}
      {done > 0 && (
        <button
          className={next === "export" ? "primary-button" : ""}
          disabled={disabled}
          title={blockedTitle}
          onClick={onExport}
        >
          {exportLabel}
        </button>
      )}
    </div>
  );
}

/** The row above the tracks and chart: one tab per corrected track, and the
 * Segments / Écoute switch when the detail is too low (`view`). */
export function DetailTabs({
  tracks,
  value,
  onChange,
  view,
}: {
  tracks: readonly (readonly [string, string])[];
  value: string;
  onChange: (value: string) => void;
  view?: { value: AnalysisView; onChange: (view: AnalysisView) => void };
}) {
  const t = useT();
  return (
    <div className="detail-tabs">
      <PillSwitch className="detail-track-tabs" label={t.multi.shownTrack} options={tracks} value={value} onChange={onChange} />
      {view && <ViewSwitch value={view.value} onChange={view.onChange} />}
    </div>
  );
}

/** "PISTES ?" over the tracks table, and "(manuel)" with the button back
 * to the top bar's pick (`reset`) once they were picked by hand -- or
 * "(auto)" when the top bar's reference doesn't fit them (`auto`: why). */
export function TracksHeading({
  hint,
  reset,
  auto,
}: {
  hint: string;
  reset?: { label: string; title: string; disabled: boolean; onClick: () => void };
  auto?: string;
}) {
  const t = useT();
  return (
    <div className="detail-heading">
      <h3>
        {t.multi.tracks} <InfoTip>{hint}</InfoTip>
      </h3>
      {auto && (
        <span className="list-row-manual">
          {t.multi.auto} <InfoTip>{auto}</InfoTip>
        </span>
      )}
      {reset && <span className="list-row-manual">{t.multi.manual}</span>}
      {reset && (
        <button className="small-button" disabled={reset.disabled} title={reset.title} onClick={reset.onClick}>
          {reset.label}
        </button>
      )}
    </div>
  );
}

/** "SEGMENTS" and its summary over the shown track's chart -- or, before
 * there's one, the chart's frame saying what's going on (nothing to
 * correct, not analyzed, waiting, running, failed, with its log). */
export function DetailChart({
  summary,
  result,
  run,
  fill,
  noTrack,
}: {
  summary: ReactNode;
  result: SegmentsResponse | null;
  run: AnalysisRun | undefined;
  /** The chart takes the panel's height (the Segments tab). */
  fill: boolean;
  /** Set when there's no track to correct: why. */
  noTrack: string | null;
}) {
  const t = useT();
  return (
    <div className="detail-chart">
      <div className="detail-heading">
        <h3>{t.common.segments}</h3>
        <span className="detail-heading-summary">{summary}</span>
      </div>
      {result ? (
        <SegmentChart segments={result.segments} fill={fill} />
      ) : (
        // Its room kept while there's nothing to draw yet.
        <SegmentChartPlaceholder>
          {noTrack && <p className="placeholder">{noTrack}</p>}
          {!noTrack && !run && <p className="placeholder">{t.multi.notAnalyzed}</p>}
          {run?.status === "pending" && <p className="placeholder">{t.batch.pending}</p>}
          {run?.status === "running" && (
            <p className="placeholder detail-running">
              <span className="spinner spinner-small" />
              {t.common.analysisRunning}
            </p>
          )}
          {run?.status === "error" && <p className="error">{run.error ?? t.common.error}</p>}
          <LogPanel lines={run?.log ?? []} />
        </SegmentChartPlaceholder>
      )}
    </div>
  );
}

/** Under a detail: how its export went (running, the file written with its
 * folder, the error, cancelled), with its log. Nothing before an export. */
export function DetailExport({ entry }: { entry: ExportFields | null | undefined }) {
  const t = useT();
  if (!entry || entry.exportStatus === "idle") return null;
  const written = writtenFile(entry);
  return (
    <div className={`detail-export batch-status-${entry.exportStatus}`}>
      {entry.exportStatus === "running" && t.common.exportRunning}
      {entry.exportStatus === "done" && written && (
        <span className="render-success" title={written}>
          {t.common.written(basename(written))}
        </span>
      )}
      {entry.exportStatus === "error" && (entry.exportError ?? t.common.error)}
      {entry.exportStatus === "cancelled" && t.common.exportCancelled}
      <RevealButton file={written} />
      <LogPanel lines={entry.exportLog} />
    </div>
  );
}

/** Under the tracks table: the subtitle tracks retimed with the corrected
 * ones ("@3 fre forcés", each one's full name on hover), and "Changer". */
export function RetimedSubs({
  subtitles,
  assigned,
  disabled,
  onChange,
}: {
  /** The file's subtitle tracks. */
  subtitles: SubtitleInfo[];
  /** Those going with each corrected track (by its index). */
  assigned: Record<number, number[]>;
  disabled: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const retimed = subtitles.filter((s) => Object.values(assigned).some((subs) => subs.includes(s.index)));
  return (
    <div className="detail-subs">
      <span className="detail-subs-text" title={retimed.map((s) => subtitleLabel(s)).join("\n") || undefined}>
        {t.multi.retimedSubs} {retimed.length > 0 ? retimed.map((s) => subtitleShortLabel(s)).join(", ") : t.multi.noSubs}
      </span>
      <button className="small-button" disabled={disabled} onClick={onChange}>
        {t.multi.changeSubs}
      </button>
    </div>
  );
}

/** "Changer": which subtitle tracks go with each corrected track, ticked
 * by hand (it applies at once); one subtitle track with one audio track. */
export function SubtitleChoiceDialog({
  title,
  titleTooltip,
  tracks,
  subtitles,
  assigned,
  onToggle,
  onClose,
}: {
  title: string;
  titleTooltip?: string;
  /** The corrected tracks: index and name. */
  tracks: readonly (readonly [number, string])[];
  subtitles: SubtitleInfo[];
  assigned: Record<number, number[]>;
  onToggle: (track: number, sub: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog onClose={onClose} closeOnBackdrop className="batch-choice-panel" labelledBy="subs-title">
      <DialogHeader id="subs-title" title={title} titleTooltip={titleTooltip} onClose={onClose} closeIcon />
      <div className="batch-choice-subs">
        <h3>
          {t.multi.subsToRetime} <InfoTip>{t.multi.subsToRetimeHint}</InfoTip>
        </h3>
        {tracks.map(([index, name]) => (
          <div key={index} className="batch-choice-subs-row">
            <span className="batch-target-name">{t.multi.withTrack(name)}</span>
            <SubtitleChecks
              subtitles={subtitles}
              chosen={assigned[index] ?? []}
              taken={takenByOthers(assigned, index)}
              onToggle={(sub) => onToggle(index, sub)}
            />
          </div>
        ))}
      </div>
    </Dialog>
  );
}
