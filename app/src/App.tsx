import { useCallback, useEffect, useState } from "react";
import {
  checkHealth,
  probe,
  startSegmentsJob,
  startPrefetchJob,
  startSegmentedRenderJob,
  connectJobWS,
  type TrackInfo,
  type SegmentsResponse,
  type PrefetchResponse,
  type RenderResponse,
} from "./api";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SegmentChart, describeSegments } from "./SegmentChart";
import { LogPanel } from "./LogPanel";
import { SegmentEditor } from "./SegmentEditor";
import { TrackPreview } from "./TrackPreview";
import { BatchView } from "./BatchView";
import { UpdateBanner } from "./UpdateBanner";
import { pickMediaFiles, pickOutputFile, syncedFileName } from "./mediaDialog";
import { basename } from "./paths";
import "./App.css";

type EngineStatus = "starting" | "ready" | "unreachable";

const HEALTH_POLL_ATTEMPTS = 40; // 40 * 500ms = 20s before giving up

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
  log: string[];
  written: string | null;
  error: string | null;
}

const IDLE_EXPORT: ExportState = { running: false, log: [], written: null, error: null };

function App() {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("starting");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
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

  const pollHealth = useCallback(() => {
    let cancelled = false;
    let attempts = 0;
    setEngineStatus("starting");
    async function poll() {
      if (await checkHealth()) {
        if (!cancelled) setEngineStatus("ready");
        return;
      }
      attempts += 1;
      if (attempts > HEALTH_POLL_ATTEMPTS) {
        if (!cancelled) setEngineStatus("unreachable");
        return;
      }
      if (!cancelled) setTimeout(poll, 500);
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => pollHealth(), [pollHealth]);

  async function handleOpenFile() {
    const selected = await pickMediaFiles(false);
    if (selected) await openFile(selected);
  }

  // Dev only (stripped from production builds): `?open=<path>` opens a file
  // without the system dialog, for automated layout screenshots in a plain
  // browser, where Tauri's dialog doesn't exist.
  useEffect(() => {
    if (!import.meta.env.DEV || engineStatus !== "ready") return;
    const path = new URLSearchParams(window.location.search).get("open");
    if (path) openFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineStatus]);

  async function openFile(selected: string) {
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

    try {
      const res = await probe(selected);
      setTracks(res.tracks);
      if (res.tracks.length >= 2) {
        setReferenceIndex(res.tracks[0].index);
        setTargetIndices(res.tracks.slice(1).map((t) => t.index));
        prefetchTracks(selected, res.tracks.map((t) => t.index));
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Fire-and-forget: warms the engine's cache so the first "Analyser" click
   * doesn't pay the ~7s-per-track extraction cost that's otherwise
   * unavoidable on a cold cache (see api.ts's startPrefetchJob). */
  function prefetchTracks(path: string, trackIndices: number[]) {
    setPrefetching(true);
    startPrefetchJob(path, trackIndices)
      .then((jobId) => {
        connectJobWS<PrefetchResponse>(jobId, (event) => {
          if (event.type !== "log") setPrefetching(false);
        });
      })
      .catch(() => setPrefetching(false));
  }

  function handleReferenceChange(index: number) {
    setReferenceIndex(index);
    // A track can't be both the reference and something to correct.
    setTargetIndices((current) => current.filter((i) => i !== index));
  }

  function toggleTarget(index: number) {
    setTargetIndices((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    );
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
      const jobId = await startSegmentsJob(filePath, refIndex, filePath, trackIndex);
      connectJobWS<SegmentsResponse>(jobId, (event) => {
        if (event.type === "log") {
          updateAnalysis(trackIndex, (e) => ({ log: [...e.log, event.message] }));
        } else if (event.type === "done") {
          updateAnalysis(trackIndex, { status: "done", result: event.result });
        } else if (event.type === "error") {
          updateAnalysis(trackIndex, { status: "error", error: event.message });
        }
      });
    } catch (err) {
      updateAnalysis(trackIndex, { status: "error", error: err instanceof Error ? err.message : String(err) });
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
  const exportTracks = exportableTracks.filter((t) => !exportExcluded.includes(t.index));
  // One output file has one reference track: tracks analyzed against
  // different references (the reference was changed in between) can't be
  // exported together.
  const exportReferences = [...new Set(exportTracks.map((t) => analyses[t.index].referenceIndex))];
  const exportReference = exportReferences.length === 1 ? exportReferences[0] : null;
  const exportReferenceTrack = tracks?.find((t) => t.index === exportReference);

  function toggleExportTrack(index: number) {
    setExportExcluded((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]));
  }

  async function exportFile() {
    if (!filePath || exportReference === null || exportTracks.length === 0) return;
    const outputPath = await pickOutputFile(syncedFileName(filePath));
    if (!outputPath) return;
    if (outputPath.toLowerCase() === filePath.toLowerCase()) {
      setExportState({ ...IDLE_EXPORT, error: "Choisis un autre nom que le fichier d'origine : il ne peut pas être remplacé pendant sa lecture." });
      return;
    }
    setExportState({ ...IDLE_EXPORT, running: true });
    try {
      const jobId = await startSegmentedRenderJob(
        filePath,
        exportReference,
        exportTracks.map((t) => ({ trackIndex: t.index, segments: analyses[t.index].result!.segments })),
        outputPath,
      );
      connectJobWS<RenderResponse>(jobId, (event) => {
        if (event.type === "log") {
          setExportState((s) => ({ ...s, log: [...s.log, event.message] }));
        } else if (event.type === "done") {
          setExportState((s) => ({ ...s, running: false, written: event.result.written[0] ?? outputPath }));
        } else if (event.type === "error") {
          setExportState((s) => ({ ...s, running: false, error: event.message }));
        }
      });
    } catch (err) {
      setExportState((s) => ({ ...s, running: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const editingEntry = editingTrack !== null ? analyses[editingTrack] : null;

  // Nothing in the app is usable before the sidecar answers -- a full-screen
  // splash instead of a text banner over an inert shell makes that obvious
  // and stops the user from clicking around a UI that can't do anything yet.
  if (engineStatus !== "ready") {
    return (
      <div className="container startup-screen">
        {engineStatus === "starting" ? (
          <>
            <div className="spinner" aria-hidden="true" />
            <p className="startup-text">Démarrage du moteur...</p>
          </>
        ) : (
          <>
            <p className="startup-text error">Moteur injoignable — le sidecar a-t-il démarré ? (voir la console)</p>
            <button onClick={pollHealth}>Réessayer</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="container">
      <UpdateBanner />
      <div className="mode-switch">
        <button className={mode === "single" ? "primary-button" : ""} onClick={() => setMode("single")}>
          Fichier unique
        </button>
        <button className={mode === "batch" ? "primary-button" : ""} onClick={() => setMode("batch")}>
          Batch
        </button>
      </div>

      {/* Always mounted, just hidden -- unmounting on tab switch (as a
          `mode === "batch" ? <BatchView /> : ...` ternary did before) would
          reset BatchView's own state (imported files, etc.) every time the
          user came back to this tab. Inline `display: none` is required
          (not the `hidden` attribute): `[hidden]` is a user-agent-origin
          style, which always loses to .batch-main's own author-origin
          `display: grid` regardless of specificity. */}
      <BatchView hidden={mode !== "batch"} />

      {mode === "single" && (
      <main className="app-main">
        <div className="left-column">
          <button className="primary-button file-open-button" onClick={handleOpenFile}>
            Ouvrir un fichier
          </button>

          <section className="panel field-tracks">
            <h2>Pistes</h2>
            {filePath && (
              <p className="file-path" title={filePath}>
                {basename(filePath)}
              </p>
            )}
            {prefetching && (
              <p className="prefetch-status" title="Analyse des pistes en arrière-plan pour accélérer le premier clic sur Analyser.">
                Analyse audio en cours...
              </p>
            )}
            {!tracks && !probeError && <p className="placeholder">Ouvre un fichier pour voir ses pistes.</p>}
            {probeError && <p className="error">{probeError}</p>}
            {tracks && tracks.length < 2 && (
              <p className="error">Ce fichier n'a qu'une seule piste audio : rien à comparer.</p>
            )}
            {tracks && tracks.length >= 2 && (
              <>
                <div className="tracks-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Piste</th>
                        <th>Langue</th>
                        <th>Codec</th>
                        <th>Réf.</th>
                        <th>Analyser</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tracks.map((t) => (
                        <tr key={t.index}>
                          <td>@{t.index}</td>
                          <td>{t.language ?? "?"}</td>
                          <td>{t.codec ?? "?"}</td>
                          <td>
                            <input
                              type="radio"
                              name="reference"
                              checked={referenceIndex === t.index}
                              onChange={() => handleReferenceChange(t.index)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              disabled={referenceIndex === t.index}
                              checked={targetIndices.includes(t.index)}
                              onChange={() => toggleTarget(t.index)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="tracks-actions">
                  <button
                    className="primary-button"
                    onClick={handleAnalyzeSelected}
                    disabled={referenceIndex === null || targetIndices.length === 0 || anySelectedRunning}
                    title="Détecte le décalage de chaque piste cochée par rapport à la référence (dérive et sauts nets inclus), avec la courbe correspondante."
                  >
                    {anySelectedRunning ? "Analyse en cours..." : "Analyser"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        <section className="panel field-analysis">
          <h2>Analyse</h2>
          {analyzedTracks.length === 0 && (
            <p className="placeholder">Coche une ou plusieurs pistes à corriger, puis clique sur « Analyser ».</p>
          )}
          {/* A single analyzed track needs no tab: its card's title names it. */}
          {analyzedTracks.length > 1 && (
            <div className="analysis-tabs">
              {analyzedTracks.map((t) => {
                const entry = analyses[t.index];
                return (
                  <button
                    key={t.index}
                    className={`analysis-tab status-${entry.status}${activeAnalysisTab === t.index ? " active" : ""}`}
                    onClick={() => setActiveAnalysisTab(t.index)}
                  >
                    Piste @{t.index}
                  </button>
                );
              })}
            </div>
          )}
          {analyzedTracks
            .filter((t) => t.index === activeAnalysisTab)
            .map((t) => {
              const entry = analyses[t.index];
              return (
                <div className={`analysis-card status-${entry.status}`} key={t.index}>
                  <div className="analysis-top">
                    <div className="analysis-summary">
                      <h3>
                        Piste @{t.index} ({t.language ?? "?"})
                      </h3>
                      <LogPanel lines={entry.log} />
                      {entry.error && <p className="error">{entry.error}</p>}
                      {entry.status === "running" && !entry.result && (
                        <p className="placeholder">Analyse en cours...</p>
                      )}
                      {entry.result && <p className="analysis-description">{describeSegments(entry.result.segments)}</p>}
                    </div>
                    {entry.result && (
                      <SegmentChart segments={entry.result.segments} onEdit={() => setEditingTrack(t.index)} />
                    )}
                  </div>
                  {entry.result && (
                    <div className="segments-result">
                      {/* Not while this track is being edited: the editor has its
                          own preview, and two playing at once would overlap. */}
                      {filePath && editingTrack !== t.index && (
                        <TrackPreview
                          referenceFilePath={filePath}
                          candidateFilePath={filePath}
                          referenceIndex={entry.referenceIndex}
                          trackIndex={t.index}
                          segments={entry.result.segments}
                          referenceStartTime={tracks?.find((tr) => tr.index === entry.referenceIndex)?.start_time ?? 0}
                          trackStartTime={t.start_time}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}

          {exportableTracks.length > 0 && tracks && (
            <div className="export-bar">
              <div className="export-details">
                <div className="export-choice">
                  <span className="export-label">Pistes corrigées à inclure :</span>
                  {exportableTracks.map((t) => (
                    <label key={t.index} className="export-track">
                      <input
                        type="checkbox"
                        checked={!exportExcluded.includes(t.index)}
                        disabled={exportState.running}
                        onChange={() => toggleExportTrack(t.index)}
                      />
                      @{t.index} ({t.language ?? "?"})
                    </label>
                  ))}
                </div>
                {exportTracks.length > 0 && exportReference === null && (
                  <p className="error">
                    Ces pistes ont été analysées avec des références différentes : relance l'analyse avec une seule
                    référence pour les exporter ensemble.
                  </p>
                )}
                {exportReferenceTrack && (
                  <p className="export-summary">
                    Le fichier contiendra la vidéo, la référence @{exportReferenceTrack.index} (
                    {exportReferenceTrack.language ?? "?"}),{" "}
                    {exportTracks.length > 1 ? "les pistes corrigées" : "la piste corrigée"}{" "}
                    {exportTracks.map((t) => `@${t.index} (${t.language ?? "?"})`).join(", ")} et les sous-titres.
                    {tracks.length > exportTracks.length + 1 && " Les autres pistes audio ne sont pas incluses."}
                  </p>
                )}
                <LogPanel lines={exportState.log} />
                {exportState.error && <p className="error">{exportState.error}</p>}
                {exportState.written && (
                  <div className="export-written">
                    <span className="render-success" title={exportState.written}>
                      Fichier écrit : {basename(exportState.written)}
                    </span>
                    <button className="small-button" onClick={() => revealItemInDir(exportState.written!)}>
                      Ouvrir le dossier
                    </button>
                  </div>
                )}
              </div>
              <button
                className="primary-button export-button"
                onClick={exportFile}
                disabled={exportState.running || exportReference === null}
              >
                {exportState.running ? "Export en cours..." : "Exporter le fichier synchronisé"}
              </button>
            </div>
          )}
        </section>
      </main>
      )}

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
