import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { startSegmentsJob, connectJobWS, type SegmentsResponse } from "./api";
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
 * finishing sooner. */
function runSegmentsJob(
  referencePath: string,
  referenceIndex: number,
  trackPath: string,
  trackIndex: number,
  onLog: (message: string) => void,
): Promise<SegmentsResponse> {
  return new Promise((resolve, reject) => {
    startSegmentsJob(referencePath, referenceIndex, trackPath, trackIndex)
      .then((jobId) => {
        connectJobWS<SegmentsResponse>(jobId, (event) => {
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
}

interface FileListProps {
  title: string;
  hint: string;
  files: string[];
  onOpen: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

/** One side of the batch pairing: its own file list, reorderable in place
 * (drag would feel nicer, but up/down arrows are far less fiddly to get
 * right and every row still needs a keyboard-reachable way to move). Row
 * index (1-based, shown) is exactly what pairs it with the other list's
 * same-index row -- see BatchView's pairing summary. */
function FileList({ title, hint, files, onOpen, onMove, onRemove }: FileListProps) {
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
            <tbody>
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

/** Batch mode: process a whole series of episodes in one pass instead of
 * one file at a time. Two independently-imported file lists, paired
 * strictly by position (row 1 of each = pair 1, etc.) -- chosen over
 * auto-matching by filename for predictability: a wrong position is
 * visible and fixable with the up/down arrows, a wrong filename-based
 * guess could silently pair the wrong episodes. One reference/candidate
 * track index pair, applied to every pair alike -- a series is assumed to
 * keep the same track layout episode to episode (both @0 is a real,
 * expected case: a reference file with only VO and a to-correct file with
 * only VF). Export isn't wired up yet -- this slice stops at detection, to
 * confirm the pairing + analysis flow before building render on top.
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
  const [running, setRunning] = useState(false);

  async function pickFiles(setFiles: (files: string[]) => void) {
    const selected = await open({ multiple: true, filters: MEDIA_FILTERS });
    if (!selected) return;
    setFiles(Array.isArray(selected) ? selected : [selected]);
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const unpaired = Math.abs(referenceFiles.length - candidateFiles.length);

  function updatePair(index: number, patch: Partial<PairAnalysis>) {
    setAnalyses((current) => current.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  async function handleAnalyzeAll() {
    setRunning(true);
    setAnalyses(Array.from({ length: pairCount }, () => ({ status: "pending", result: null, error: null })));
    for (let i = 0; i < pairCount; i++) {
      updatePair(i, { status: "running" });
      try {
        const result = await runSegmentsJob(referenceFiles[i], referenceTrackIndex, candidateFiles[i], candidateTrackIndex, () => {});
        updatePair(i, { status: "done", result });
      } catch (err) {
        updatePair(i, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    setRunning(false);
  }

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      <div className="batch-config panel">
        <label>
          Piste référence :
          <input
            type="number"
            min={0}
            value={referenceTrackIndex}
            onChange={(e) => setReferenceTrackIndex(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <label>
          Piste à corriger :
          <input
            type="number"
            min={0}
            value={candidateTrackIndex}
            onChange={(e) => setCandidateTrackIndex(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <span className="batch-config-hint">Appliqué à toutes les paires.</span>
        <button className="primary-button" onClick={handleAnalyzeAll} disabled={pairCount === 0 || running}>
          {running ? "Analyse en cours..." : "Analyser tout"}
        </button>
      </div>

      <FileList
        title="Fichiers référence"
        hint="Piste à ne jamais modifier (ex. VO), une par épisode."
        files={referenceFiles}
        onOpen={() => pickFiles(setReferenceFiles)}
        onMove={(from, to) => setReferenceFiles((f) => moved(f, from, to))}
        onRemove={(i) => setReferenceFiles((f) => f.filter((_, idx) => idx !== i))}
      />
      <FileList
        title="Fichiers à corriger"
        hint="Piste à resynchroniser et intégrer (ex. VF), une par épisode."
        files={candidateFiles}
        onOpen={() => pickFiles(setCandidateFiles)}
        onMove={(from, to) => setCandidateFiles((f) => moved(f, from, to))}
        onRemove={(i) => setCandidateFiles((f) => f.filter((_, idx) => idx !== i))}
      />

      {(referenceFiles.length > 0 || candidateFiles.length > 0) && (
        <p className="batch-pair-summary">
          {pairCount} paire{pairCount > 1 ? "s" : ""} formée{pairCount > 1 ? "s" : ""} par position (ligne 1 ↔ ligne 1, etc.).
          {unpaired > 0 && ` ${unpaired} fichier${unpaired > 1 ? "s" : ""} sans binôme, ignoré${unpaired > 1 ? "s" : ""} pour l'instant.`}
        </p>
      )}

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
              </colgroup>
              <thead>
                <tr>
                  <th className="batch-index">#</th>
                  <th>Référence</th>
                  <th>À corriger</th>
                  <th>Statut</th>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
