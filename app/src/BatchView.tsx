import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  probe,
  startSegmentsJob,
  startCrossFileSegmentedRenderJob,
  connectJobWS,
  type SegmentsResponse,
  type RenderResponse,
  type TrackInfo,
} from "./api";
import { SegmentEditor } from "./SegmentEditor";
import { LogPanel } from "./LogPanel";
import { basename } from "./paths";
import "./BatchView.css";

const MEDIA_FILTERS = [{ name: "Vidéo/Audio", extensions: ["mkv", "mp4", "wav", "flac", "aac", "mp3"] }];

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

interface FileListProps {
  title: string;
  hint: string;
  files: string[];
  tbodyRef: React.RefObject<HTMLTableSectionElement | null>;
  onOpen: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

/** One side of the batch pairing: its own file list, reorderable in place
 * (drag would feel nicer, but up/down arrows are far less fiddly to get
 * right and every row still needs a keyboard-reachable way to move).
 * `tbodyRef` lets BatchView measure each row's real screen position, to
 * float a ↔ between this table and the other one at the same height --
 * see usePairArrowTops for why that needs actual measurement rather than
 * a CSS-only layout trick. */
function FileList({ title, hint, files, tbodyRef, onOpen, onMove, onRemove }: FileListProps) {
  return (
    <section className="panel batch-file-list">
      <h2>{title}</h2>
      <button className="primary-button file-open-button" onClick={onOpen}>
        Ouvrir des fichiers
      </button>
      <p className="batch-hint">{hint}</p>
      {files.length === 0 ? (
        <p className="placeholder">Aucun fichier sélectionné.</p>
      ) : (
        <div className="batch-table-wrap">
          <table>
            {/* table-layout: fixed sizes columns strictly from this row's
                widths, not any row's -- without it, the empty actions <th>
                (no text to size itself by) let the browser hand it far more
                width than its 3 tiny buttons need, at the filename's
                expense. */}
            <colgroup>
              <col className="batch-col-index" />
              <col />
              <col className="batch-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th className="batch-index">#</th>
                <th>Fichier</th>
                <th></th>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {files.map((f, i) => (
                <tr key={`${i}-${f}`}>
                  <td className="batch-index">{i + 1}</td>
                  <td className="batch-filename" title={f}>
                    {basename(f)}
                  </td>
                  <td className="batch-row-actions">
                    <button className="small-button" onClick={() => onMove(i, i - 1)} disabled={i === 0} title="Monter">
                      ↑
                    </button>
                    <button
                      className="small-button"
                      onClick={() => onMove(i, i + 1)}
                      disabled={i === files.length - 1}
                      title="Descendre"
                    >
                      ↓
                    </button>
                    <button className="small-button" onClick={() => onRemove(i)} title="Retirer">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Real screen Y-position (relative to `containerRef`'s box) of each of the
 * first `rowCount` rows, read from whichever of the two tbodies actually
 * has that row. A reserved connector column (an earlier version of this)
 * kept its own rows the same height as the real tables by sharing their
 * exact CSS classes -- but both `.panel` and `.batch-table-wrap` clip
 * overflow (for their rounded corners), so anything meant to float loose
 * in the gap *between* two clipped boxes can't be a descendant of either:
 * it has to be a sibling, positioned from real measured coordinates
 * instead of shared layout. Recomputed on resize (a ResizeObserver on the
 * container catches width changes; row count/content changes go through
 * the effect's own dependency list). */
function usePairArrowTops(
  containerRef: React.RefObject<HTMLDivElement | null>,
  leftTbodyRef: React.RefObject<HTMLTableSectionElement | null>,
  rightTbodyRef: React.RefObject<HTMLTableSectionElement | null>,
  rowCount: number,
): number[] {
  const [tops, setTops] = useState<number[]>([]);

  useLayoutEffect(() => {
    function recompute() {
      const container = containerRef.current;
      if (!container || rowCount === 0) {
        setTops([]);
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      const leftRows = leftTbodyRef.current?.children;
      const rightRows = rightTbodyRef.current?.children;
      const next: number[] = [];
      for (let i = 0; i < rowCount; i++) {
        const row = (leftRows?.[i] ?? rightRows?.[i]) as HTMLElement | undefined;
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        next.push(rect.top + rect.height / 2 - containerTop);
      }
      setTops(next);
    }
    recompute();
    const container = containerRef.current;
    const ro = new ResizeObserver(recompute);
    if (container) ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, leftTbodyRef, rightTbodyRef, rowCount]);

  return tops;
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
 * checked instead of just hoped. Export isn't wired up yet -- this slice
 * stops at detection, to confirm the pairing + analysis flow before
 * building render on top.
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

  const pairingRowRef = useRef<HTMLDivElement>(null);
  const referenceTbodyRef = useRef<HTMLTableSectionElement>(null);
  const candidateTbodyRef = useRef<HTMLTableSectionElement>(null);

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

  async function pickFiles(setFiles: (files: string[]) => void) {
    const selected = await open({ multiple: true, filters: MEDIA_FILTERS });
    if (!selected) return;
    setFiles(Array.isArray(selected) ? selected : [selected]);
  }

  /** `analyses` is indexed by pairing position, so moving or removing a
   * file in either list shifts what every later index actually refers to
   * -- keeping the old entries around would either crash the results table
   * (reading a filename past the shrunk list's end) or, worse, silently
   * show/export a pair's analysis against the wrong file. Clearing forces
   * a re-analysis instead of trusting stale indices. */
  function resetAnalyses() {
    setAnalyses([]);
    setEditingPairIndex(null);
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  // No arrows/warnings at all until both sides have at least one file --
  // one list starting empty while the other is being built up is a normal,
  // expected in-progress state, not a mismatch worth flagging (pairCount
  // would otherwise be 0 and every row past it would show a ⚠).
  const bothStarted = referenceFiles.length > 0 && candidateFiles.length > 0;
  const rowCount = bothStarted ? Math.max(referenceFiles.length, candidateFiles.length) : 0;
  const arrowTops = usePairArrowTops(pairingRowRef, referenceTbodyRef, candidateTbodyRef, rowCount);

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

  const exportableCount = analyses.filter((a) => a.status === "done" && a.result).length;

  /** Exports every successfully-analyzed pair, in the order analyzed --
   * pairs that failed detection or never ran are left alone (exportStatus
   * stays "idle") rather than attempted, since there's no segment list to
   * render from. Uses each pair's current `result.segments`, which is
   * exactly what "Modifier" (below) lets the user hand-adjust first -- same
   * principle as the single-file view: export must reflect a reviewed
   * edit, not silently re-run detection and discard it. Both buttons below
   * are disabled while *either* operation runs, not just their own: export
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
        <span className="batch-config-hint">D'après le 1er fichier de chaque liste, appliqué à toutes les paires.</span>
        <button
          className="small-button"
          onClick={() => setShowTracksModal(true)}
          disabled={referenceFiles.length === 0 && candidateFiles.length === 0}
        >
          Vérifier toutes les pistes
        </button>
        <button className="primary-button" onClick={handleAnalyzeAll} disabled={pairCount === 0 || analyzing || exporting}>
          {analyzing ? "Analyse en cours..." : "Analyser tout"}
        </button>
        <button className="primary-button" onClick={handleExportAll} disabled={exportableCount === 0 || analyzing || exporting}>
          {exporting ? "Export en cours..." : "Exporter tout"}
        </button>
      </div>

      <div className="batch-pairing-row" ref={pairingRowRef}>
        <FileList
          title="Fichiers référence"
          hint="Piste à ne jamais modifier (ex. VO), une par épisode."
          files={referenceFiles}
          tbodyRef={referenceTbodyRef}
          onOpen={() => pickFiles(setReferenceFiles)}
          onMove={(from, to) => {
            setReferenceFiles((f) => moved(f, from, to));
            resetAnalyses();
          }}
          onRemove={(i) => {
            setReferenceFiles((f) => f.filter((_, idx) => idx !== i));
            resetAnalyses();
          }}
        />
        <FileList
          title="Fichiers à corriger"
          hint="Piste à resynchroniser et intégrer (ex. VF), une par épisode."
          files={candidateFiles}
          tbodyRef={candidateTbodyRef}
          onOpen={() => pickFiles(setCandidateFiles)}
          onMove={(from, to) => {
            setCandidateFiles((f) => moved(f, from, to));
            resetAnalyses();
          }}
          onRemove={(i) => {
            setCandidateFiles((f) => f.filter((_, idx) => idx !== i));
            resetAnalyses();
          }}
        />
        {/* Sibling overlay, not a descendant of either panel -- see
            usePairArrowTops for why that matters (.panel/.batch-table-wrap
            both clip overflow for their rounded corners). pointer-events:
            none (set in CSS) lets clicks reach the real buttons underneath. */}
        <div className="batch-arrows-overlay" aria-hidden="true">
          {arrowTops.map((top, i) => (
            <span key={i} className={`batch-pair-arrow${i >= pairCount ? " batch-pair-arrow-warn" : ""}`} style={{ top }}>
              {i < pairCount ? "↔" : "⚠"}
            </span>
          ))}
        </div>
      </div>

      {analyses.length > 0 && (
        <div className="batch-results panel">
          <h2>Résultats</h2>
          <div className="batch-table-wrap">
            <table>
              <colgroup>
                <col className="batch-col-index" />
                <col />
                <col />
                <col />
                <col />
                <col className="batch-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="batch-index">#</th>
                  <th>Référence</th>
                  <th>À corriger</th>
                  <th>Analyse</th>
                  <th>Export</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {analyses.map((a, i) => (
                  <tr key={i}>
                    <td className="batch-index">{i + 1}</td>
                    <td className="batch-filename" title={referenceFiles[i]}>
                      {basename(referenceFiles[i])}
                    </td>
                    <td className="batch-filename" title={candidateFiles[i]}>
                      {basename(candidateFiles[i])}
                    </td>
                    <td className={`batch-status batch-status-${a.status}`}>
                      {a.status === "pending" && "En attente"}
                      {a.status === "running" && "Analyse en cours..."}
                      {a.status === "done" &&
                        a.result &&
                        `${a.result.segments.length} segment${a.result.segments.length > 1 ? "s" : ""}`}
                      {a.status === "error" && (a.error ?? "Erreur")}
                      <LogPanel lines={a.log} />
                    </td>
                    <td className={`batch-status batch-status-${a.exportStatus === "idle" ? "pending" : a.exportStatus}`}>
                      {a.exportStatus === "idle" && "—"}
                      {a.exportStatus === "running" && "Export en cours..."}
                      {a.exportStatus === "done" && a.exportResult && basename(a.exportResult.written[0] ?? "")}
                      {a.exportStatus === "error" && (a.exportError ?? "Erreur")}
                      <LogPanel lines={a.exportLog} />
                    </td>
                    <td className="batch-row-actions">
                      <button
                        className="small-button"
                        onClick={() => setEditingPairIndex(i)}
                        disabled={a.status !== "done" || !a.result}
                      >
                        Modifier
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
