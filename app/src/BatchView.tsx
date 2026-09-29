import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  probe,
  startSegmentsJob,
  startCrossFileSegmentedRenderJob,
  connectJobWS,
  type SegmentsResponse,
  type RenderResponse,
  type TrackInfo,
} from "./api";
import { InfoTip } from "./InfoTip";
import { describeSegments } from "./SegmentChart";
import { SegmentEditor } from "./SegmentEditor";
import { LogPanel } from "./LogPanel";
import { pickMediaFiles } from "./mediaDialog";
import { basename } from "./paths";
import "./BatchView.css";


function moved<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Promise wrapper around the callback-based connectJobWS -- needed here
 * (unlike the single-file view) because pairs run one after another and
 * each must be awaited before the next starts, rather than all firing
 * concurrently: a batch can be many episodes, and each analysis is already
 * CPU-heavy across every core on its own (see analysis_cache/features.py),
 * so running several at once would oversubscribe cores instead of
 * finishing sooner. Renders are lighter, but kept sequential too, for the
 * same predictable one-at-a-time progress and to avoid writing several
 * large output files to disk at once. */
function runJob<T>(jobId: Promise<string>, onLog: (message: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    jobId
      .then((id) => {
        connectJobWS<T>(id, (event) => {
          if (event.type === "log") onLog(event.message);
          else if (event.type === "done") resolve(event.result);
          else if (event.type === "error") reject(new Error(event.message));
        });
      })
      .catch(reject);
  });
}

interface PairAnalysis {
  status: "pending" | "running" | "done" | "error";
  result: SegmentsResponse | null;
  error: string | null;
  log: string[];
  exportStatus: "idle" | "pending" | "running" | "done" | "error";
  exportResult: RenderResponse | null;
  exportError: string | null;
  exportLog: string[];
}

const IDLE_EXPORT = { exportStatus: "idle" as const, exportResult: null, exportError: null, exportLog: [] as string[] };

/** Probes one file's tracks, to fill the track-picker dropdown. Only ever
 * called on the *first* file of each list, not every file: one picked
 * index applies to every pair (see BatchView's docstring, "a series keeps
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
}

/** A dropdown of the first file's actual tracks (index/language/codec),
 * not a blind number field -- falls back to a plain number input when
 * there's nothing to probe yet or probing failed, so picking is never
 * blocked on that. */
function TrackPicker({ label, tracks, loading, error, value, onChange }: TrackPickerProps) {
  return (
    <label>
      {label} :
      {tracks && tracks.length > 0 ? (
        <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {tracks.map((t) => (
            <option key={t.index} value={t.index}>
              @{t.index} — {t.language ?? "?"} ({t.codec ?? "?"})
            </option>
          ))}
        </select>
      ) : (
        <input type="number" min={0} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value)))} />
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

/** One file of a pair, with the buttons that move it within its column (so
 * it pairs with another row) or drop it. A dash when its column is shorter
 * than the other one. The arrows carry U+FE0E, which asks for the plain
 * text glyph: Windows may otherwise draw them as colored emoji. */
function FileCell({
  files,
  index,
  disabled,
  onChange,
}: {
  files: string[];
  index: number;
  disabled: boolean;
  onChange: (update: (files: string[]) => string[]) => void;
}) {
  const file = files[index];
  if (file === undefined) return <td className="batch-file batch-file-missing">—</td>;
  return (
    <td className="batch-file">
      <div className="batch-file-inner">
        <span className="batch-filename" title={file}>
          {basename(file)}
        </span>
        <span className="batch-file-actions">
          <button
            className="small-button"
            onClick={() => onChange((f) => moved(f, index, index - 1))}
            disabled={disabled || index === 0}
            title="Monter"
          >
            {"\u2191\uFE0E"}
          </button>
          <button
            className="small-button"
            onClick={() => onChange((f) => moved(f, index, index + 1))}
            disabled={disabled || index === files.length - 1}
            title="Descendre"
          >
            {"\u2193\uFE0E"}
          </button>
          <button
            className="small-button"
            onClick={() => onChange((f) => f.filter((_, i) => i !== index))}
            disabled={disabled}
            title="Retirer"
          >
            ✕
          </button>
        </span>
      </div>
    </td>
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

/** Batch mode: process a whole series of episodes in one pass instead of
 * one file at a time. Two independently-imported file lists, paired
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
export function BatchView({ hidden }: { hidden: boolean }) {
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [candidateFiles, setCandidateFiles] = useState<string[]>([]);
  const [referenceTrackIndex, setReferenceTrackIndex] = useState(0);
  const [candidateTrackIndex, setCandidateTrackIndex] = useState(1);
  const [analyses, setAnalyses] = useState<PairAnalysis[]>([]);
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

  /** `analyses` is indexed by pairing position, so moving or removing a
   * file in either list shifts what every later index actually refers to
   * -- keeping the old entries around would either crash the table
   * (reading a filename past the shrunk list's end) or, worse, silently
   * show/export a pair's analysis against the wrong file. Clearing forces
   * a re-analysis instead of trusting stale indices. */
  function resetAnalyses() {
    setAnalyses([]);
    setEditingPairIndex(null);
  }

  async function addFiles(setFiles: (update: (files: string[]) => string[]) => void) {
    const selected = await pickMediaFiles(true);
    if (!selected) return;
    setFiles((files) => [...files, ...selected]);
    resetAnalyses();
  }

  function editList(setFiles: (update: (files: string[]) => string[]) => void, update: (files: string[]) => string[]) {
    setFiles(update);
    resetAnalyses();
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const rowCount = Math.max(referenceFiles.length, candidateFiles.length);

  function updatePair(index: number, patch: Partial<PairAnalysis> | ((entry: PairAnalysis) => Partial<PairAnalysis>)) {
    setAnalyses((current) =>
      current.map((a, i) => (i === index ? { ...a, ...(typeof patch === "function" ? patch(a) : patch) } : a)),
    );
  }

  async function handleAnalyzeAll() {
    setAnalyzing(true);
    setAnalyses(Array.from({ length: pairCount }, () => ({ status: "pending", result: null, error: null, log: [], ...IDLE_EXPORT })));
    for (let i = 0; i < pairCount; i++) {
      updatePair(i, { status: "running" });
      try {
        const result = await runJob<SegmentsResponse>(
          startSegmentsJob(referenceFiles[i], referenceTrackIndex, candidateFiles[i], candidateTrackIndex),
          (message) => updatePair(i, (a) => ({ log: [...a.log, message] })),
        );
        updatePair(i, { status: "done", result });
      } catch (err) {
        updatePair(i, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    setAnalyzing(false);
  }

  const analyzedCount = analyses.filter((a) => a.status === "done" && a.result).length;
  const exportedCount = analyses.filter((a) => a.exportStatus === "done").length;

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
  async function handleExportAll() {
    setExporting(true);
    for (let i = 0; i < analyses.length; i++) {
      const entry = analyses[i];
      if (entry.status !== "done" || !entry.result) continue;
      updatePair(i, { exportStatus: "running", exportLog: [] });
      try {
        const result = await runJob<RenderResponse>(
          startCrossFileSegmentedRenderJob(
            referenceFiles[i],
            referenceTrackIndex,
            candidateFiles[i],
            candidateTrackIndex,
            entry.result.segments,
          ),
          (message) => updatePair(i, (a) => ({ exportLog: [...a.exportLog, message] })),
        );
        updatePair(i, { exportStatus: "done", exportResult: result });
      } catch (err) {
        updatePair(i, { exportStatus: "error", exportError: err instanceof Error ? err.message : String(err) });
      }
    }
    setExporting(false);
  }

  const busy = analyzing || exporting;

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      <div className="batch-config panel">
        <TrackPicker
          label="Piste référence"
          tracks={referenceProbe.tracks}
          loading={referenceProbe.loading}
          error={referenceProbe.error}
          value={referenceTrackIndex}
          onChange={setReferenceTrackIndex}
        />
        <TrackPicker
          label="Piste à corriger"
          tracks={candidateProbe.tracks}
          loading={candidateProbe.loading}
          error={candidateProbe.error}
          value={candidateTrackIndex}
          onChange={setCandidateTrackIndex}
        />
        <InfoTip>
          Pistes proposées d'après le 1er fichier de chaque colonne, puis appliquées à toutes les paires. « Vérifier
          toutes les pistes » montre celles de chaque fichier.
        </InfoTip>
        <button className="small-button" onClick={() => setShowTracksModal(true)} disabled={rowCount === 0}>
          Vérifier toutes les pistes
        </button>
      </div>

      <section className="panel batch-jobs">
        <div className="batch-jobs-header">
          <h2>Paires</h2>
          <button
            className="small-button"
            onClick={() => {
              setReferenceFiles([]);
              setCandidateFiles([]);
              resetAnalyses();
            }}
            disabled={busy || rowCount === 0}
          >
            Tout retirer
          </button>
          <InfoTip align="right">
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
                      onClick={() => addFiles(setReferenceFiles)}
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
                      onClick={() => addFiles(setCandidateFiles)}
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
                const a = analyses[i];
                const written = a?.exportResult?.written[0];
                return (
                  <tr key={i} className={i >= pairCount ? "batch-row-unpaired" : undefined}>
                    <td className="batch-index">{i + 1}</td>
                    <FileCell
                      files={referenceFiles}
                      index={i}
                      disabled={busy}
                      onChange={(update) => editList(setReferenceFiles, update)}
                    />
                    <FileCell
                      files={candidateFiles}
                      index={i}
                      disabled={busy}
                      onChange={(update) => editList(setCandidateFiles, update)}
                    />
                    <td className={`batch-status batch-status-${a?.status ?? "pending"}`}>
                      {!a && (i < pairCount ? "—" : "⚠ Sans paire")}
                      {a?.status === "pending" && "En attente"}
                      {a?.status === "running" && "Analyse en cours..."}
                      {a?.status === "done" && a.result && describeSegments(a.result.segments)}
                      {a?.status === "error" && (a.error ?? "Erreur")}
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
                      {a && (a.exportStatus === "running" || a.exportStatus === "error") && (
                        <LogPanel lines={a.exportLog} />
                      )}
                    </td>
                    <td className="batch-row-actions">
                      <button
                        className="small-button"
                        onClick={() => setEditingPairIndex(i)}
                        disabled={a?.status !== "done" || !a.result}
                      >
                        Modifier
                      </button>
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
        <span className="batch-progress">
          {pairCount} paire{pairCount > 1 ? "s" : ""}
          {analyses.length > 0 && ` · ${analyzedCount}/${analyses.length} analysée${analyzedCount > 1 ? "s" : ""}`}
          {exportedCount > 0 && ` · ${exportedCount} exportée${exportedCount > 1 ? "s" : ""}`}
          {rowCount > pairCount && ` · ${rowCount - pairCount} fichier${rowCount - pairCount > 1 ? "s" : ""} sans paire`}
        </span>
        <button className="primary-button" onClick={handleAnalyzeAll} disabled={pairCount === 0 || busy}>
          {analyzing ? "Analyse en cours..." : "Analyser tout"}
        </button>
        <button className="primary-button" onClick={handleExportAll} disabled={analyzedCount === 0 || busy}>
          {exporting ? "Export en cours..." : "Exporter tout"}
        </button>
      </div>

      {showTracksModal && (
        <AllTracksModal referenceFiles={referenceFiles} candidateFiles={candidateFiles} onClose={() => setShowTracksModal(false)} />
      )}

      {editingPairIndex !== null && analyses[editingPairIndex]?.result && (
        <SegmentEditor
          segments={analyses[editingPairIndex].result.segments}
          onClose={() => setEditingPairIndex(null)}
          onSave={(edited) => {
            const i = editingPairIndex;
            setAnalyses((current) =>
              current.map((a, idx) => (idx === i && a.result ? { ...a, result: { ...a.result, segments: edited } } : a)),
            );
          }}
          preview={{
            referenceFilePath: referenceFiles[editingPairIndex],
            candidateFilePath: candidateFiles[editingPairIndex],
            referenceIndex: referenceTrackIndex,
            trackIndex: candidateTrackIndex,
          }}
        />
      )}
    </main>
  );
}
