import { useCallback, useEffect, useRef, useState } from "react";
import {
  probe,
  startSegmentsJob,
  startPrefetchJob,
  startSegmentedRenderJob,
  cancelJob,
  setEngineLanguage,
  type SubtitleInfo,
  type TrackInfo,
  type SegmentsResponse,
  type PrefetchResponse,
  type RenderResponse,
} from "./api";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SegmentChart, describeSegments } from "./SegmentChart";
import { DropZone } from "./DropZone";
import { InfoTip } from "./InfoTip";
import { LogPanel } from "./LogPanel";
import { SegmentEditor } from "./SegmentEditor";
import { TrackPreview } from "./TrackPreview";
import { BatchView, type BatchMode } from "./BatchView";
import { OptionsButton } from "./Options";
import { PillSwitch } from "./PillSwitch";
import { UpdateButton } from "./UpdateButton";
import { pickMediaFiles, pickOutputFile, syncedFileName } from "./mediaDialog";
import { basename } from "./paths";
import { assignSubtitles, subtitlesFor, takenByOthers } from "./subtitles";
import { useElementSize } from "./useElementSize";
import "./App.css";
import { devParam, errorMessage, loadSetting, saveSetting, toggled } from "./util";
import { TrackTable } from "./TrackTable";
import { SubtitleChecks } from "./SubtitleChecks";
import { JobCancelled, runJob } from "./jobs";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { useLanguage, useT } from "./i18n";
import { useSubtitleDefault } from "./settings";
import { EngineStatusBadge } from "./EngineStatus";

/**
 * Per-track analysis + export state, keyed by track index. There used to be
 * a separate "quick" flat-offset flow (align) alongside this one, but once
 * the analysis cache made both equally fast, the flat flow was strictly
 * weaker (no drift/jump detection, and its "confidence" value was already
 * known to be unreliable) except for launching several tracks at once --
 * so that's folded in here instead: checking several boxes below fires one
 * of these per track.
 */
interface TrackAnalysis {
  status: "running" | "done" | "error";
  referenceIndex: number;
  log: string[];
  result: SegmentsResponse | null;
  error: string | null;
}

/** The one export of the open file: every chosen corrected track goes into
 * the same output, so exporting never overwrites another track's export. */
interface ExportState {
  running: boolean;
  // The running export's job, to cancel it ("Annuler l'export").
  jobId: string | null;
  cancelling: boolean;
  cancelled: boolean;
  log: string[];
  written: string | null;
  error: string | null;
}

const IDLE_EXPORT: ExportState = {
  running: false,
  jobId: null,
  cancelling: false,
  cancelled: false,
  log: [],
  written: null,
  error: null,
};

// The batch sub-mode last used, picked again next time.
const BATCH_MODE_KEY = "syncaudio.batchMode";

// Height of the analysis panel's content below which the chart and the
// waveforms are shown one at a time (see compactAnalysis).
const COMPACT_ANALYSIS_HEIGHT = 520;

function App() {
  const t = useT();
  const [mode, setMode] = useState<"single" | "batch">("single");
  // Dev only (see devParam): pairs mode for `?batchRef=`.
  const [batchMode, setBatchMode] = useState<BatchMode>(() =>
    devParam("batchRef") || loadSetting(BATCH_MODE_KEY) === "pairs" ? "pairs" : "multi",
  );
  // A batch analysis or export is running: the other sub-mode waits.
  const [batchBusy, setBatchBusy] = useState(false);
  const chooseBatchMode = useCallback((next: BatchMode) => {
    setBatchMode(next);
    saveSetting(BATCH_MODE_KEY, next === "multi" ? null : next);
  }, []);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleInfo[]>([]);
  // Subtitle tracks picked by hand for an analyzed track (by its index);
  // absent: its language's forced subtitles (see subsByTrack).
  const [subsChoice, setSubsChoice] = useState<Record<number, number[]>>({});
  const [referenceIndex, setReferenceIndex] = useState<number | null>(null);
  const [targetIndices, setTargetIndices] = useState<number[]>([]);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [prefetching, setPrefetching] = useState(false);

  const [analyses, setAnalyses] = useState<Record<number, TrackAnalysis>>({});
  const [editingTrack, setEditingTrack] = useState<number | null>(null);
  // Which analyzed track's tab is showing -- only one card is ever rendered
  // at a time (see field-analysis below), so an arbitrary number of
  // analyzed tracks never needs the panel itself to scroll.
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<number | null>(null);
  // Analyzed tracks the user unticked from the export (every analyzed track
  // is included by default, so a new analysis joins the export on its own).
  const [exportExcluded, setExportExcluded] = useState<number[]>([]);
  const [exportState, setExportState] = useState<ExportState>(IDLE_EXPORT);
  const [analysisViewRef, analysisViewSize] = useElementSize<HTMLDivElement>();
  const [analysisView, setAnalysisView] = useState<"segments" | "listen">("listen");
  // Bumped each time a file is opened: a job started for the previous file
  // (analysis, prefetch) that answers afterwards is ignored instead of
  // landing in the new file's view.
  const fileGenRef = useRef(0);

  // The engine's messages (job logs, errors) in the UI's language whenever
  // it changes (engine.ts sends it once the engine is up).
  const language = useLanguage();
  useEffect(() => {
    setEngineLanguage(language).catch(() => {});
  }, [language]);

  // A file dropped on the window opens like a picked one (the first, if several).
  const dropBlocked = exportState.running ? t.single.exportRunningHint : null;
  const fileDrag = useFileDrop(
    mode === "single" && editingTrack === null,
    dropBlocked,
    (files) => openFile(files[0]),
  );

  async function handleOpenFile() {
    const selected = await pickMediaFiles(false);
    if (selected) await openFile(selected);
  }

  // Dev only (see devParam): `?open=<path>` opens a file, `?mode=batch`
  // starts on batch mode.
  useEffect(() => {
    if (devParam("mode") === "batch") setMode("batch");
    const path = devParam("open");
    if (path) openFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openFile(selected: string) {
    const gen = ++fileGenRef.current;
    setFilePath(selected);
    setTracks(null);
    setReferenceIndex(null);
    setTargetIndices([]);
    setProbeError(null);
    setAnalyses({});
    setEditingTrack(null);
    setActiveAnalysisTab(null);
    setExportExcluded([]);
    setExportState(IDLE_EXPORT);
    setSubtitles([]);
    setSubsChoice({});

    try {
      const res = await probe(selected);
      if (gen !== fileGenRef.current) return;
      setTracks(res.tracks);
      setSubtitles(res.subtitles ?? []);
      if (res.tracks.length >= 2) {
        setReferenceIndex(res.tracks[0].index);
        setTargetIndices(res.tracks.slice(1).map((t) => t.index));
        prefetchTracks(selected, res.tracks.map((t) => t.index));
      }
    } catch (err) {
      if (gen === fileGenRef.current) setProbeError(errorMessage(err));
    }
  }

  /** Fire-and-forget: warms the engine's cache so the first "Analyser" click
   * doesn't pay the ~7s-per-track extraction cost that's otherwise
   * unavoidable on a cold cache (see api.ts's startPrefetchJob). */
  function prefetchTracks(path: string, trackIndices: number[]) {
    const gen = fileGenRef.current;
    const done = () => {
      if (gen === fileGenRef.current) setPrefetching(false);
    };
    setPrefetching(true);
    runJob<PrefetchResponse>(startPrefetchJob(path, trackIndices), () => {})
      .catch(() => {
        // the next analysis just does the work itself
      })
      .finally(done);
  }

  function handleReferenceChange(index: number) {
    setReferenceIndex(index);
    // A track can't be both the reference and something to correct.
    setTargetIndices((current) => current.filter((i) => i !== index));
  }

  function toggleTarget(index: number) {
    setTargetIndices((current) => toggled(current, index));
  }

  function updateAnalysis(trackIndex: number, patch: Partial<TrackAnalysis> | ((entry: TrackAnalysis) => Partial<TrackAnalysis>)) {
    setAnalyses((current) => {
      const entry = current[trackIndex];
      if (!entry) return current;
      const nextPatch = typeof patch === "function" ? patch(entry) : patch;
      return { ...current, [trackIndex]: { ...entry, ...nextPatch } };
    });
  }

  async function analyzeTrack(trackIndex: number, refIndex: number) {
    if (!filePath) return;
    const gen = fileGenRef.current;
    const update: typeof updateAnalysis = (index, patch) => {
      if (gen === fileGenRef.current) updateAnalysis(index, patch);
    };
    setAnalyses((current) => ({
      ...current,
      [trackIndex]: {
        status: "running",
        referenceIndex: refIndex,
        log: [],
        result: null,
        error: null,
      },
    }));
    try {
      const result = await runJob<SegmentsResponse>(
        startSegmentsJob(filePath, refIndex, filePath, trackIndex),
        (message) => update(trackIndex, (e) => ({ log: [...e.log, message] })),
      );
      update(trackIndex, { status: "done", result });
    } catch (err) {
      update(trackIndex, { status: "error", error: errorMessage(err) });
    }
  }

  function handleAnalyzeSelected() {
    if (referenceIndex === null) return;
    for (const idx of targetIndices) {
      analyzeTrack(idx, referenceIndex);
    }
    if (targetIndices.length > 0) {
      // Keep whatever tab the user's already looking at if it's still part
      // of this run; otherwise default to the first newly-analyzed track.
      setActiveAnalysisTab((current) => (current !== null && targetIndices.includes(current) ? current : targetIndices[0]));
    }
  }

  const anySelectedRunning = targetIndices.some((i) => analyses[i]?.status === "running");
  const analyzedTracks = (tracks ?? []).filter((t) => analyses[t.index]);
  const exportableTracks = analyzedTracks.filter((t) => analyses[t.index].result);
  // The subtitle tracks retimed with each analyzed track: those picked by
  // hand, or per the default setting (Options; its language's forced ones
  // unless changed). One subtitle track goes with one audio track at most
  // (the first to claim it).
  const subtitleDefault = useSubtitleDefault();
  const subsByTrack = assignSubtitles(
    analyzedTracks,
    (t) => subsChoice[t.index] ?? subtitlesFor(subtitles, t.language, subtitleDefault),
  );
  const exportTracks = exportableTracks.filter((t) => !exportExcluded.includes(t.index));
  const retimedSubs = exportTracks.flatMap((t) => subsByTrack[t.index] ?? []);
  // What an export would contain now: once it changes (another analysis, a
  // track or subtitle unticked, segments edited), the last export's outcome
  // no longer describes it.
  const exportContent = JSON.stringify(
    exportTracks.map((t) => [t.index, analyses[t.index].result?.segments, subsByTrack[t.index]]),
  );
  useEffect(() => {
    setExportState((s) => (s.running ? s : IDLE_EXPORT));
  }, [exportContent]);
  // One output file has one reference track: tracks analyzed against
  // different references (the reference was changed in between) can't be
  // exported together.
  const exportReferences = [...new Set(exportTracks.map((t) => analyses[t.index].referenceIndex))];
  const exportReference = exportReferences.length === 1 ? exportReferences[0] : null;
  const exportReferenceTrack = tracks?.find((t) => t.index === exportReference);
  const exportSummary =
    exportReferenceTrack &&
    t.single.exportSummary(
      `@${exportReferenceTrack.index} (${exportReferenceTrack.language ?? "?"})`,
      exportTracks.map((tr) => `@${tr.index} (${tr.language ?? "?"})`),
      retimedSubs.map((i) => `@${i}`),
      (tracks?.length ?? 0) > exportTracks.length + 1,
    );

  function toggleExportTrack(index: number) {
    setExportExcluded((current) => toggled(current, index));
  }

  async function exportFile() {
    if (!filePath || exportReference === null || exportTracks.length === 0) return;
    const outputPath = await pickOutputFile(syncedFileName(filePath));
    if (!outputPath) return;
    if (outputPath.toLowerCase() === filePath.toLowerCase()) {
      setExportState({ ...IDLE_EXPORT, error: t.single.sameAsInput });
      return;
    }
    setExportState({ ...IDLE_EXPORT, running: true });
    try {
      const result = await runJob<RenderResponse>(
        startSegmentedRenderJob(
          filePath,
          exportReference,
          exportTracks.map((t) => ({
            trackIndex: t.index,
            segments: analyses[t.index].result!.segments,
            subtitles: subsByTrack[t.index] ?? [],
          })),
          outputPath,
        ),
        (message) => setExportState((s) => ({ ...s, log: [...s.log, message] })),
        (jobId) => setExportState((s) => ({ ...s, jobId })),
      );
      setExportState((s) => ({ ...s, running: false, jobId: null, written: result.written[0] ?? outputPath }));
    } catch (err) {
      if (err instanceof JobCancelled) {
        setExportState((s) => ({ ...s, running: false, jobId: null, cancelling: false, cancelled: true }));
      } else {
        setExportState((s) => ({ ...s, running: false, jobId: null, error: errorMessage(err) }));
      }
    }
  }

  /** Stop the running export: the engine kills it and removes the
   * half-written file; the export can then be started again. */
  async function cancelExport() {
    if (!exportState.jobId) return;
    setExportState((s) => ({ ...s, cancelling: true }));
    try {
      await cancelJob(exportState.jobId);
    } catch (err) {
      setExportState((s) => ({ ...s, cancelling: false, error: errorMessage(err) }));
    }
  }
  const editingEntry = editingTrack !== null ? analyses[editingTrack] : null;
  const shownTrack = analyzedTracks.find((t) => t.index === activeAnalysisTab) ?? null;
  const shownEntry = shownTrack ? analyses[shownTrack.index] : null;
  const shownReference = shownEntry ? tracks?.find((t) => t.index === shownEntry.referenceIndex) : undefined;
  // Below this height, the chart and three readable waveforms don't fit
  // together in the analysis panel: they become two tabs instead.
  const compactAnalysis = analysisViewSize.height > 0 && analysisViewSize.height < COMPACT_ANALYSIS_HEIGHT;

  return (
    <div className="container">
      <div className="top-bar">
        <div className="mode-switch">
          <button className={mode === "single" ? "primary-button" : ""} onClick={() => setMode("single")}>
            {t.modes.single}
          </button>
          {/* Batch, and its sub-modes in a drawer that unrolls from under it
              (folded away, and out of the tab order, outside Batch). */}
          <div className={`batch-group${mode === "batch" ? " open" : ""}`}>
            <button
              className={mode === "batch" ? "primary-button batch-main-button" : "batch-main-button"}
              onClick={() => setMode("batch")}
              aria-expanded={mode === "batch"}
            >
              {t.modes.batch}
            </button>
            <div className="batch-drawer" inert={mode !== "batch"}>
              <div className="batch-drawer-clip">
                <PillSwitch
                  className="batch-submodes"
                  label={t.modes.batchModes}
                  options={[
                    ["multi", t.batch.multiMode],
                    ["pairs", t.batch.pairsMode],
                  ]}
                  value={batchMode}
                  onChange={chooseBatchMode}
                  disabled={batchBusy}
                  disabledTitle={t.modes.batchBusy}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="top-actions">
          <EngineStatusBadge />
          <UpdateButton />
          <OptionsButton />
        </div>
      </div>

      {/* Always mounted, just hidden -- unmounting on tab switch (as a
          `mode === "batch" ? <BatchView /> : ...` ternary did before) would
          reset BatchView's own state (imported files, etc.) every time the
          user came back to this tab. Inline `display: none` is required
          (not the `hidden` attribute): `[hidden]` is a user-agent-origin
          style, which always loses to .batch-main's own author-origin
          `display: grid` regardless of specificity. */}
      <BatchView hidden={mode !== "batch"} mode={batchMode} onBusyChange={setBatchBusy} />

      {mode === "single" && (
      <main className="app-main">
        <div className="left-column">
          <button
            className="primary-button file-open-button"
            onClick={handleOpenFile}
            disabled={exportState.running}
            title={exportState.running ? t.single.exportRunningHint : undefined}
          >
            {t.single.openFile}
          </button>

          <section className="panel field-tracks">
            <h2>
              {t.single.tracks} <InfoTip>{t.single.tracksHint}</InfoTip>
            </h2>
            {filePath && (
              <p className="file-path" title={filePath}>
                {basename(filePath)}
              </p>
            )}
            {prefetching && (
              <p className="prefetch-status" title={t.single.preparingHint}>
                {t.single.preparing}
              </p>
            )}
            {!tracks && !probeError && (
              // Opened but not read yet: the engine may still be starting.
              <p className="placeholder">{filePath ? t.single.readingTracks : t.single.openToSeeTracks}</p>
            )}
            {probeError && <p className="error">{probeError}</p>}
            {tracks && tracks.length < 2 && (
              <p className="error">{t.single.singleTrack}</p>
            )}
            {tracks && tracks.length >= 2 && (
              <>
                <div className="tracks-table-wrap list-scroll">
                  <TrackTable
                    tracks={tracks}
                    reference={referenceIndex}
                    targets={targetIndices}
                    onReference={handleReferenceChange}
                    onToggleTarget={toggleTarget}
                  />
                </div>

                <div className="tracks-actions">
                  <button
                    className="primary-button"
                    onClick={handleAnalyzeSelected}
                    disabled={referenceIndex === null || targetIndices.length === 0 || anySelectedRunning}
                    title={t.single.analyzeHint}
                  >
                    {anySelectedRunning ? t.common.analysisRunning : t.single.analyze}
                  </button>
                </div>
              </>
            )}
          </section>

          {analyzedTracks.length > 0 && tracks && (
            <section className="panel field-results">
              <h2>{t.single.analyzedTracks}</h2>
              {/* One row per analyzed track: clicking it shows that track on
                  the right; its checkbox puts it in the export below. */}
              <ul className="result-list list-scroll">
                {analyzedTracks.map((tr) => {
                  const entry = analyses[tr.index];
                  return (
                    <li
                      key={tr.index}
                      className={`result-row status-${entry.status}${activeAnalysisTab === tr.index ? " active" : ""}`}
                      onClick={() => setActiveAnalysisTab(tr.index)}
                    >
                      <div className="result-row-head">
                        <input
                          type="checkbox"
                          title={t.single.includeInExport}
                          checked={entry.result !== null && !exportExcluded.includes(tr.index)}
                          disabled={entry.result === null || exportState.running}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleExportTrack(tr.index)}
                        />
                        <span className="result-name">
                          @{tr.index} ({tr.language ?? "?"})
                        </span>
                        <span className="result-status">
                          {entry.status === "running" && t.common.analysisRunning}
                          {entry.status === "error" && t.single.failed}
                          {entry.result && describeSegments(entry.result.segments)}
                        </span>
                      </div>
                      {entry.error && <p className="error">{entry.error}</p>}
                      {entry.result && subtitles.length > 0 && (
                        <div className="result-subs" onClick={(e) => e.stopPropagation()}>
                          <span className="result-subs-label">
                            {t.single.retimeSubs} <InfoTip>{t.single.retimeSubsHint}</InfoTip>
                          </span>
                          <SubtitleChecks
                            subtitles={subtitles}
                            chosen={subsByTrack[tr.index] ?? []}
                            taken={takenByOthers(subsByTrack, tr.index)}
                            disabled={exportState.running}
                            onToggle={(sub) =>
                              setSubsChoice((c) => ({ ...c, [tr.index]: toggled(subsByTrack[tr.index] ?? [], sub) }))
                            }
                          />
                        </div>
                      )}
                      <div onClick={(e) => e.stopPropagation()}>
                        <LogPanel lines={entry.log} />
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="export-box">
                {exportableTracks.length > 0 && exportTracks.length === 0 && (
                  <p className="placeholder">{t.single.tickOne}</p>
                )}
                {exportTracks.length > 0 && exportReference === null && (
                  <p className="error">{t.single.mixedReferences}</p>
                )}
                {exportSummary && (
                  <p className="export-summary">
                    {t.single.exportContent} <InfoTip>{exportSummary}</InfoTip>
                  </p>
                )}
                <LogPanel lines={exportState.log} />
                {exportState.error && <p className="error">{exportState.error}</p>}
                {exportState.written && (
                  <div className="export-written">
                    <span className="render-success" title={exportState.written}>
                      {t.single.written(basename(exportState.written))}
                    </span>
                    <button className="small-button" onClick={() => revealItemInDir(exportState.written!)}>
                      {t.single.openFolder}
                    </button>
                  </div>
                )}
                {exportState.cancelled && <p className="export-cancelled">{t.single.exportCancelled}</p>}
                {exportState.running ? (
                  <div className="export-running">
                    <span className="export-running-label">{t.common.exportRunning}</span>
                    <button
                      className="export-cancel"
                      onClick={cancelExport}
                      disabled={!exportState.jobId || exportState.cancelling}
                    >
                      {exportState.cancelling ? t.common.cancelling : t.common.cancelExport}
                    </button>
                  </div>
                ) : (
                  <button className="primary-button export-button" onClick={exportFile} disabled={exportReference === null}>
                    {t.single.exportButton}
                  </button>
                )}
              </div>
            </section>
          )}
        </div>

        <section className="panel field-analysis">
          <div className="analysis-header">
            <h2>
              {shownTrack && shownEntry
                ? t.single.heading(
                    `@${shownTrack.index} (${shownTrack.language ?? "?"})`,
                    `@${shownEntry.referenceIndex} (${shownReference?.language ?? "?"})`,
                  )
                : t.common.analysis}
            </h2>
            {/* Too little height for the chart and readable waveforms at
                once: one at a time, as tabs. */}
            {compactAnalysis && shownEntry?.result && (
              <PillSwitch
                className="view-switch"
                label={t.common.view}
                options={[
                  ["segments", t.common.segments],
                  ["listen", t.common.listen],
                ]}
                value={analysisView}
                onChange={setAnalysisView}
              />
            )}
            {shownTrack && shownEntry?.result && (
              <button className="small-button analysis-edit" onClick={() => setEditingTrack(shownTrack.index)}>
                {t.single.editSegments}
              </button>
            )}
          </div>
          <div className="analysis-view" ref={analysisViewRef}>
            {!filePath && (
              <DropZone title={t.files.dropZoneOne} onClick={handleOpenFile}>
                {t.files.dropZoneOneHint}
              </DropZone>
            )}
            {filePath && !shownEntry && <p className="placeholder">{t.single.pickAndAnalyze}</p>}
            {shownEntry?.status === "running" && !shownEntry.result && <p className="placeholder">Analyse en cours...</p>}
            {shownEntry?.status === "error" && <p className="error">{shownEntry.error}</p>}
            {shownTrack && shownEntry?.result && (
              <>
                <div
                  className={
                    !compactAnalysis ? "analysis-chart" : analysisView === "segments" ? "analysis-chart analysis-chart-fill" : "view-hidden"
                  }
                >
                  <SegmentChart segments={shownEntry.result.segments} fill={compactAnalysis} />
                </div>
                {/* Hidden rather than unmounted while on the other tab, so
                    playback and zoom survive switching. Not while this track
                    is being edited: the editor has its own preview, and two
                    playing at once would overlap. */}
                {filePath && editingTrack !== shownTrack.index && (
                  <div className={compactAnalysis && analysisView !== "listen" ? "view-hidden" : "segments-result"}>
                    <TrackPreview
                      key={shownTrack.index}
                      referenceFilePath={filePath}
                      candidateFilePath={filePath}
                      referenceIndex={shownEntry.referenceIndex}
                      trackIndex={shownTrack.index}
                      segments={shownEntry.result.segments}
                      referenceStartTime={shownReference?.start_time ?? 0}
                      trackStartTime={shownTrack.start_time}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>
      )}

      {mode === "single" && <DropOverlay drag={fileDrag} blocked={dropBlocked} label={t.files.dropToOpen} />}

      {mode === "single" && editingTrack !== null && editingEntry?.result && (
        <SegmentEditor
          segments={editingEntry.result.segments}
          preview={
            filePath
              ? {
                  referenceFilePath: filePath,
                  candidateFilePath: filePath,
                  referenceIndex: editingEntry.referenceIndex,
                  trackIndex: editingTrack,
                  referenceStartTime: tracks?.find((tr) => tr.index === editingEntry.referenceIndex)?.start_time ?? 0,
                  trackStartTime: tracks?.find((tr) => tr.index === editingTrack)?.start_time ?? 0,
                }
              : undefined
          }
          onClose={() => setEditingTrack(null)}
          onSave={(edited) =>
            updateAnalysis(editingTrack, (e) => ({ result: e.result ? { ...e.result, segments: edited } : e.result }))
          }
        />
      )}
    </div>
  );
}

export default App;
