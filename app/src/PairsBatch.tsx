import { useEffect, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  probe,
  startSegmentsJob,
  cancelJob,
  startCrossFileSegmentedRenderJob,
  type SegmentsResponse,
  type RenderResponse,
  type TrackInfo,
} from "./api";
import {
  AnalyzeButton,
  FileCell,
  JobCancelled,
  LanguageSelect,
  OTHER_MODE_BUSY,
  OutputChooser,
  runJob,
  useEscape,
} from "./batchShared";
import { InfoTip } from "./InfoTip";
import { describeSegments } from "./SegmentChart";
import { SegmentEditor } from "./SegmentEditor";
import { LogPanel } from "./LogPanel";
import { pickMediaFiles, planOutputPaths } from "./mediaDialog";
import { basename } from "./paths";
import { SUBTITLE_MODES, subtitlesFor, type SubtitleMode } from "./subtitles";


interface PairAnalysis {
  status: "pending" | "running" | "done" | "error";
  result: SegmentsResponse | null;
  error: string | null;
  log: string[];
  exportStatus: "idle" | "pending" | "running" | "done" | "error" | "cancelled";
  exportResult: RenderResponse | null;
  exportError: string | null;
  exportLog: string[];
}

const IDLE_EXPORT = { exportStatus: "idle" as const, exportResult: null, exportError: null, exportLog: [] as string[] };

/** Probes one file's tracks, to fill the track-picker dropdown. Only ever
 * called on the *first* file of each list, not every file: one picked
 * index applies to every pair (see PairsBatch's docstring, "a series keeps
 * the same track layout episode to episode"), so probing every file in a
 * big batch just to fill a dropdown would be slow and redundant -- the
 * "Vérifier toutes les pistes" modal below is what covers checking every
 * file individually when that assumption needs auditing. */
function useTracksOf(path: string | undefined): { tracks: TrackInfo[] | null; loading: boolean; error: string | null } {
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setTracks(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    probe(path)
      .then((res) => {
        if (!cancelled) setTracks(res.tracks);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { tracks, loading, error };
}

interface TrackPickerProps {
  label: string;
  tracks: TrackInfo[] | null;
  loading: boolean;
  error: string | null;
  value: number;
  onChange: (index: number) => void;
  disabled?: boolean;
}

/** A dropdown of the first file's actual tracks (index/language/codec),
 * not a blind number field -- falls back to a plain number input when
 * there's nothing to probe yet or probing failed, so picking is never
 * blocked on that. */
function TrackPicker({ label, tracks, loading, error, value, onChange, disabled }: TrackPickerProps) {
  return (
    <label>
      {label} :
      {tracks && tracks.length > 0 ? (
        <select value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled}>
          {tracks.map((t) => (
            <option key={t.index} value={t.index}>
              @{t.index} — {t.language ?? "?"} ({t.codec ?? "?"})
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          min={0}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        />
      )}
      {loading && <span className="batch-track-status">Sondage...</span>}
      {error && (
        <span className="batch-track-status batch-track-status-error" title={error}>
          Pistes indisponibles
        </span>
      )}
    </label>
  );
}

/** "Vérifier toutes les pistes" modal: probes *every* file in both lists
 * (unlike the track pickers above, which only ever look at the first file
 * of each) so the user can audit that every episode really does have the
 * expected tracks in the expected order before committing to one
 * reference/candidate index for the whole batch. Fetched fresh each time
 * the modal opens rather than kept live -- this is a manual spot-check,
 * not something that needs to track file-list edits in real time. */
function AllTracksModal({ referenceFiles, candidateFiles, onClose }: { referenceFiles: string[]; candidateFiles: string[]; onClose: () => void }) {
  const [entries, setEntries] = useState<Record<string, { tracks: TrackInfo[] | null; error: string | null }>>({});
  const [loading, setLoading] = useState(true);
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    const paths = [...new Set([...referenceFiles, ...candidateFiles])];
    setLoading(true);
    Promise.all(
      paths.map((path) =>
        probe(path)
          .then((res) => [path, { tracks: res.tracks, error: null }] as const)
          .catch((err) => [path, { tracks: null, error: err instanceof Error ? err.message : String(err) }] as const),
      ),
    ).then((results) => {
      if (cancelled) return;
      setEntries(Object.fromEntries(results));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally a one-shot snapshot on open, not live-tracking the lists
  }, []);

  function renderSide(title: string, files: string[]) {
    return (
      <div className="batch-tracks-side">
        <h3>{title}</h3>
        {files.length === 0 ? (
          <p className="placeholder">Aucun fichier.</p>
        ) : (
          files.map((path, i) => {
            const entry = entries[path];
            return (
              <div className="batch-tracks-file" key={`${i}-${path}`}>
                <p className="batch-tracks-filename" title={path}>
                  {i + 1}. {basename(path)}
                </p>
                {loading && !entry && <p className="placeholder">Sondage...</p>}
                {entry?.error && <p className="error">{entry.error}</p>}
                {entry?.tracks && (
                  <table className="batch-tracks-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Langue</th>
                        <th>Codec</th>
                        <th>Canaux</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.tracks.map((t) => (
                        <tr key={t.index}>
                          <td>@{t.index}</td>
                          <td>{t.language ?? "?"}</td>
                          <td>{t.codec ?? "?"}</td>
                          <td>{t.channels ?? "?"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="batch-tracks-overlay" role="dialog" aria-modal="true">
      <div className="batch-tracks-panel">
        <div className="batch-tracks-header">
          <h2>Vérifier toutes les pistes</h2>
          <button className="small-button" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="batch-tracks-columns">
          {renderSide("Fichiers référence", referenceFiles)}
          {renderSide("Fichiers à corriger", candidateFiles)}
        </div>
      </div>
    </div>
  );
}

/** Batch mode's "Paires de fichiers": process a whole series of episodes in
 * one pass, each episode's corrected track coming from another file than
 * its reference (a video, or an audio-only file). Two independently-
 * imported file lists, paired
 * strictly by position (row 1 of each = pair 1, etc.) -- chosen over
 * auto-matching by filename for predictability: a wrong position is
 * visible and fixable with the up/down arrows, a wrong filename-based
 * guess could silently pair the wrong episodes. One reference/candidate
 * track index pair, applied to every pair alike -- a series is assumed to
 * keep the same track layout episode to episode (both @0 is a real,
 * expected case: a reference file with only VO and a to-correct file with
 * only VF); "Vérifier toutes les pistes" lets that assumption actually be
 * checked instead of just hoped.
 *
 * Laid out as one table, one row per pair: both files, the analysis, the
 * export and the row's actions side by side, so nothing needs lining up
 * across separate lists. The table takes the height the window leaves and
 * scrolls in its own frame; nothing else in the view scrolls.
 *
 * Always kept mounted by the caller (App.tsx) even while on the other tab
 * -- `hidden` just toggles visibility -- so switching tabs never resets
 * the imported file lists or analysis results. */
export function PairsBatch({
  hidden,
  modeSwitch,
  outputDir,
  onOutputDirChange,
  blocked,
  onBusyChange,
}: {
  hidden: boolean;
  modeSwitch: ReactNode;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  /** The other batch mode is working: nothing starts here meanwhile. */
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [candidateFiles, setCandidateFiles] = useState<string[]>([]);
  const [referenceTrackIndex, setReferenceTrackIndex] = useState(0);
  const [candidateTrackIndex, setCandidateTrackIndex] = useState(1);
  // "" keeps the corrected track's own language; a code tags it with that one
  // instead (a bare .wav has none).
  const [candidateLanguage, setCandidateLanguage] = useState("");
  const [subsMode, setSubsMode] = useState<SubtitleMode>("forced");
  // Keyed by what each analysis was made of (see pairKey), not by row: moving
  // files, adding more or picking other tracks never shows a pair another
  // pair's analysis, and one that comes back finds its own again.
  const [analyses, setAnalyses] = useState<Record<string, PairAnalysis>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showTracksModal, setShowTracksModal] = useState(false);
  const [editingPairIndex, setEditingPairIndex] = useState<number | null>(null);

  const referenceProbe = useTracksOf(referenceFiles[0]);
  const candidateProbe = useTracksOf(candidateFiles[0]);

  // Re-pick a sensible default the moment a *new* first file's tracks come
  // in (e.g. the reference list was just (re)populated) -- doesn't fight a
  // manual pick afterwards, since this only fires when the tracks array
  // itself changes, not on every render.
  useEffect(() => {
    if (referenceProbe.tracks && referenceProbe.tracks.length > 0) setReferenceTrackIndex(referenceProbe.tracks[0].index);
  }, [referenceProbe.tracks]);
  useEffect(() => {
    if (candidateProbe.tracks && candidateProbe.tracks.length > 0) {
      setCandidateTrackIndex(candidateProbe.tracks.length > 1 ? candidateProbe.tracks[1].index : candidateProbe.tracks[0].index);
    }
  }, [candidateProbe.tracks]);

  // Dev only (stripped from production builds): `?batchRef=a|b&batchCand=c|d`
  // fills the lists without the system dialog, for automated screenshots.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    const refs = params.get("batchRef");
    const cands = params.get("batchCand");
    if (refs) setReferenceFiles(refs.split("|"));
    if (cands) setCandidateFiles(cands.split("|"));
  }, []);

  function addFiles(setFiles: (update: (files: string[]) => string[]) => void) {
    return async () => {
      const selected = await pickMediaFiles(true);
      if (selected) setFiles((files) => [...files, ...selected]);
    };
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const rowCount = Math.max(referenceFiles.length, candidateFiles.length);

  /** Row `i`'s pair as it stands: both files and both tracks. */
  function pairKey(i: number): string {
    return JSON.stringify([referenceFiles[i], referenceTrackIndex, candidateFiles[i], candidateTrackIndex]);
  }
  const analysisOf = (i: number): PairAnalysis | undefined => (i < pairCount ? analyses[pairKey(i)] : undefined);
  const isDone = (a: PairAnalysis | undefined) => a?.status === "done" && !!a.result;

  function updatePair(key: string, patch: Partial<PairAnalysis> | ((entry: PairAnalysis) => Partial<PairAnalysis>)) {
    setAnalyses((current) =>
      current[key] ? { ...current, [key]: { ...current[key], ...(typeof patch === "function" ? patch(current[key]) : patch) } } : current,
    );
  }

  /** Analyzes the pairs that aren't yet (new ones, failed ones), keeping the
   * rest and any edit made to them; or all of them again (`all`). */
  async function handleAnalyze(all: boolean) {
    setAnalyzing(true);
    const plan = Array.from({ length: pairCount }, (_, i) => ({
      key: pairKey(i),
      reference: referenceFiles[i],
      candidate: candidateFiles[i],
    })).filter(({ key }) => all || !isDone(analyses[key]));
    const [referenceTrack, candidateTrack] = [referenceTrackIndex, candidateTrackIndex];
    setAnalyses((current) => {
      const next = { ...current };
      for (const { key } of plan) next[key] = { status: "pending", result: null, error: null, log: [], ...IDLE_EXPORT };
      return next;
    });
    for (const { key, reference, candidate } of plan) {
      updatePair(key, { status: "running" });
      try {
        const result = await runJob<SegmentsResponse>(
          startSegmentsJob(reference, referenceTrack, candidate, candidateTrack),
          (message) => updatePair(key, (a) => ({ log: [...a.log, message] })),
        );
        updatePair(key, { status: "done", result });
      } catch (err) {
        updatePair(key, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    setAnalyzing(false);
  }

  const pairAnalyses = Array.from({ length: pairCount }, (_, i) => analysisOf(i));
  const analyzedCount = pairAnalyses.filter(isDone).length;
  const exportedCount = pairAnalyses.filter((a) => a?.exportStatus === "done").length;

  /** Exports every successfully-analyzed pair, in the order analyzed --
   * pairs that failed detection or never ran are left alone (exportStatus
   * stays "idle") rather than attempted, since there's no segment list to
   * render from. Uses each pair's current `result.segments`, which is
   * exactly what "Modifier" lets the user hand-adjust first -- same
   * principle as the single-file view: export must reflect a reviewed
   * edit, not silently re-run detection and discard it. Both buttons are
   * disabled while *either* operation runs, not just their own: export
   * reads `analyses` as it currently stands, so a concurrent re-analysis
   * could rewrite a pair's segments out from under an export already using
   * them. */
  // "Annuler l'export": stop the file being exported and don't start the next ones.
  const cancelRequested = useRef(false);
  const currentExportJob = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function cancelExports() {
    cancelRequested.current = true;
    setCancelling(true);
    if (currentExportJob.current) {
      try {
        await cancelJob(currentExportJob.current);
      } catch {
        // already over: the loop stops before the next file anyway
      }
    }
  }

  async function handleExportAll() {
    setExporting(true);
    cancelRequested.current = false;
    const toExport = pairAnalyses.flatMap((a, i) => (isDone(a) ? [i] : []));
    const keys = toExport.map(pairKey);
    let outputs: string[];
    try {
      outputs = await planOutputPaths(toExport.map((i) => referenceFiles[i]), outputDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const key of keys) updatePair(key, { exportStatus: "error", exportError: message });
      setExporting(false);
      return;
    }
    for (const [k, i] of toExport.entries()) {
      if (cancelRequested.current) break;
      const key = keys[k];
      const entry = analyses[key];
      if (!entry?.result) continue;
      updatePair(key, { exportStatus: "running", exportLog: [], exportError: null });
      try {
        // The candidate file's subtitles in its audio's language come along,
        // retimed with it (per the subtitle setting).
        const candidate = subsMode === "none" ? null : await probe(candidateFiles[i]);
        const audioLanguage =
          candidate?.tracks.find((t) => t.index === candidateTrackIndex)?.language || candidateLanguage || null;
        const result = await runJob<RenderResponse>(
          startCrossFileSegmentedRenderJob(
            referenceFiles[i],
            referenceTrackIndex,
            candidateFiles[i],
            candidateTrackIndex,
            entry.result.segments,
            {
              outputPath: outputs[k],
              language: candidateLanguage || null,
              subtitles: candidate ? subtitlesFor(candidate.subtitles ?? [], audioLanguage, subsMode) : [],
            },
          ),
          (message) => updatePair(key, (a) => ({ exportLog: [...a.exportLog, message] })),
          (id) => (currentExportJob.current = id),
        );
        updatePair(key, { exportStatus: "done", exportResult: result });
      } catch (err) {
        if (err instanceof JobCancelled) updatePair(key, { exportStatus: "cancelled" });
        else updatePair(key, { exportStatus: "error", exportError: err instanceof Error ? err.message : String(err) });
      }
      currentExportJob.current = null;
    }
    setExporting(false);
    setCancelling(false);
  }

  const busy = analyzing || exporting;
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  // The files' own start times, for the editor's informational "delay
  // already in the file" note: probed when a pair is opened for editing.
  const [editStartTimes, setEditStartTimes] = useState<{ reference?: number; track?: number }>({});
  useEffect(() => {
    setEditStartTimes({});
    if (editingPairIndex === null) return;
    let cancelled = false;
    Promise.all([probe(referenceFiles[editingPairIndex]), probe(candidateFiles[editingPairIndex])])
      .then(([ref, cand]) => {
        if (cancelled) return;
        setEditStartTimes({
          reference: ref.tracks.find((t) => t.index === referenceTrackIndex)?.start_time,
          track: cand.tracks.find((t) => t.index === candidateTrackIndex)?.start_time,
        });
      })
      .catch(() => {
        // informational only: the editor just goes without it
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the lists and tracks can't change while the editor is open
  }, [editingPairIndex]);
  const editingAnalysis = editingPairIndex !== null ? analysisOf(editingPairIndex) : undefined;

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      <div className="batch-config panel">
        {modeSwitch}
        <TrackPicker
          label="Référence"
          tracks={referenceProbe.tracks}
          loading={referenceProbe.loading}
          error={referenceProbe.error}
          value={referenceTrackIndex}
          onChange={setReferenceTrackIndex}
          disabled={busy}
        />
        <TrackPicker
          label="À corriger"
          tracks={candidateProbe.tracks}
          loading={candidateProbe.loading}
          error={candidateProbe.error}
          value={candidateTrackIndex}
          onChange={setCandidateTrackIndex}
          disabled={busy}
        />
        <label>
          Langue :
          <LanguageSelect
            value={candidateLanguage}
            onChange={setCandidateLanguage}
            extra={candidateProbe.tracks?.map((t) => t.language) ?? []}
            emptyLabel={`Celle du fichier (${
              candidateProbe.tracks?.find((t) => t.index === candidateTrackIndex)?.language ?? "aucune"
            })`}
            disabled={busy}
          />
          <InfoTip>
            Langue attribuée à la piste corrigée dans le fichier exporté. « Celle du fichier » garde la sienne ; utile
            pour une piste qui n'en a pas (un .wav, par exemple).
          </InfoTip>
        </label>
        <label>
          Sous-titres :
          <select value={subsMode} onChange={(e) => setSubsMode(e.target.value as SubtitleMode)} disabled={busy}>
            {SUBTITLE_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <InfoTip>
          Pistes proposées d'après le 1er fichier de chaque colonne, puis appliquées à toutes les paires. « Vérifier
          toutes les pistes » montre celles de chaque fichier. Les sous-titres choisis du fichier à corriger (texte
          seulement : SRT, ASS) sont importés et recalés avec sa piste audio.
        </InfoTip>
      </div>

      <section className="panel batch-jobs">
        <div className="batch-jobs-header">
          <h2>Paires</h2>
          <button
            className="small-button"
            onClick={() => {
              setReferenceFiles([]);
              setCandidateFiles([]);
              setAnalyses({});
            }}
            disabled={busy || rowCount === 0}
          >
            Tout retirer
          </button>
          <button className="small-button" onClick={() => setShowTracksModal(true)} disabled={rowCount === 0}>
            Vérifier toutes les pistes
          </button>
          <InfoTip>
            Une ligne = une paire : la référence (piste jamais modifiée, ex. VO) et le fichier dont la piste est
            resynchronisée puis intégrée (ex. VF). Les fichiers sont appariés dans l'ordre : ↑ ↓ pour corriger l'ordre
            d'une colonne.
          </InfoTip>
        </div>

        {/* Always shown, even empty: its column headers hold the buttons that
            add files to each column. */}
        <div className="batch-table-wrap list-scroll">
          <table>
            <colgroup>
              <col className="batch-col-index" />
              <col />
              <col />
              <col className="batch-col-status" />
              <col className="batch-col-status" />
              <col className="batch-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th className="batch-index">#</th>
                <th>
                  <div className="batch-th-add">
                    <span>Référence</span>
                    <button
                      className="small-button"
                      onClick={addFiles(setReferenceFiles)}
                      disabled={busy}
                      title="Ajouter des fichiers de référence (piste jamais modifiée, ex. VO), un par épisode"
                    >
                      + Ajouter
                    </button>
                  </div>
                </th>
                <th>
                  <div className="batch-th-add">
                    <span>À corriger</span>
                    <button
                      className="small-button"
                      onClick={addFiles(setCandidateFiles)}
                      disabled={busy}
                      title="Ajouter des fichiers dont la piste est à resynchroniser (ex. VF), un par épisode"
                    >
                      + Ajouter
                    </button>
                  </div>
                </th>
                <th>Analyse</th>
                <th>Export</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rowCount === 0 && (
                <tr>
                  <td colSpan={6} className="placeholder">
                    Ajoute les fichiers de référence et les fichiers à corriger, un par épisode.
                  </td>
                </tr>
              )}
              {Array.from({ length: rowCount }, (_, i) => {
                const a = analysisOf(i);
                const written = a?.exportResult?.written[0];
                return (
                  <tr key={i} className={i >= pairCount ? "batch-row-unpaired" : undefined}>
                    <td className="batch-index">{i + 1}</td>
                    <FileCell
                      files={referenceFiles}
                      index={i}
                      disabled={busy}
                      onChange={setReferenceFiles}
                    />
                    <FileCell
                      files={candidateFiles}
                      index={i}
                      disabled={busy}
                      onChange={setCandidateFiles}
                    />
                    <td className={`batch-status batch-status-${a?.status ?? "pending"}`}>
                      {!a && (i < pairCount ? "À analyser" : "⚠ Sans paire")}
                      {a?.status === "pending" && "En attente"}
                      {a?.status === "running" && "Analyse en cours..."}
                      {a?.status === "done" && a.result && describeSegments(a.result.segments)}
                      {a?.status === "error" && (a.error ?? "Erreur")}
                      {a?.status === "done" && a.result && (
                        <button className="small-button" disabled={busy} onClick={() => setEditingPairIndex(i)}>
                          Modifier
                        </button>
                      )}
                      {/* Only while it runs (progress) or when it failed (why): a
                          done row stays one line. */}
                      {a && (a.status === "running" || a.status === "error") && <LogPanel lines={a.log} />}
                    </td>
                    <td className={`batch-status batch-status-${!a || a.exportStatus === "idle" ? "pending" : a.exportStatus}`}>
                      {(!a || a.exportStatus === "idle") && "—"}
                      {a?.exportStatus === "running" && "Export en cours..."}
                      {a?.exportStatus === "done" && written && (
                        <span title={written}>{basename(written)}</span>
                      )}
                      {a?.exportStatus === "error" && (a.exportError ?? "Erreur")}
                      {a?.exportStatus === "cancelled" && "Annulé"}
                      {a && (a.exportStatus === "running" || a.exportStatus === "error") && (
                        <LogPanel lines={a.exportLog} />
                      )}
                    </td>
                    <td className="batch-row-actions">
                      {written && (
                        <button className="small-button" title="Ouvrir le dossier du fichier écrit" onClick={() => revealItemInDir(written)}>
                          Dossier
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="batch-footer panel">
        <OutputChooser outputDir={outputDir} onChange={onOutputDirChange} disabled={busy} />
        <span className="batch-progress">
          {pairCount} paire{pairCount > 1 ? "s" : ""}
          {analyzedCount > 0 && ` · ${analyzedCount}/${pairCount} analysée${analyzedCount > 1 ? "s" : ""}`}
          {exportedCount > 0 && ` · ${exportedCount} exportée${exportedCount > 1 ? "s" : ""}`}
          {rowCount > pairCount && ` · ${rowCount - pairCount} fichier${rowCount - pairCount > 1 ? "s" : ""} sans paire`}
        </span>
        <AnalyzeButton
          analyzing={analyzing}
          missing={pairCount - analyzedCount}
          analyzed={analyzedCount}
          unit="paire"
          disabled={pairCount === 0 || busy || blocked}
          blocked={blocked}
          onAnalyze={handleAnalyze}
        />
        {exporting ? (
          <button className="export-cancel" onClick={cancelExports} disabled={cancelling}>
            {cancelling ? "Annulation..." : "Annuler l'export"}
          </button>
        ) : (
          <button
            className="primary-button"
            onClick={handleExportAll}
            disabled={analyzedCount === 0 || busy || blocked}
            title={blocked ? OTHER_MODE_BUSY : undefined}
          >
            Exporter tout
          </button>
        )}
      </div>

      {showTracksModal && (
        <AllTracksModal referenceFiles={referenceFiles} candidateFiles={candidateFiles} onClose={() => setShowTracksModal(false)} />
      )}

      {editingPairIndex !== null && editingAnalysis?.result && (
        <SegmentEditor
          segments={editingAnalysis.result.segments}
          onClose={() => setEditingPairIndex(null)}
          onSave={(edited) =>
            updatePair(pairKey(editingPairIndex), (a) => ({ result: a.result ? { ...a.result, segments: edited } : a.result }))
          }
          preview={{
            referenceFilePath: referenceFiles[editingPairIndex],
            candidateFilePath: candidateFiles[editingPairIndex],
            referenceIndex: referenceTrackIndex,
            trackIndex: candidateTrackIndex,
            referenceStartTime: editStartTimes.reference,
            trackStartTime: editStartTimes.track,
          }}
        />
      )}
    </main>
  );
}
