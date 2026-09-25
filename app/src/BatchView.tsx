import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
 * guess could silently pair the wrong episodes. Detection/export for the
 * formed pairs isn't wired up yet -- this is the import + pairing slice
 * only, to validate the pairing UX before building on top of it.
 *
 * Always kept mounted by the caller (App.tsx) even while on the other tab
 * -- `hidden` just toggles visibility -- so switching tabs never resets
 * the imported file lists. */
export function BatchView({ hidden }: { hidden: boolean }) {
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [candidateFiles, setCandidateFiles] = useState<string[]>([]);

  async function pickFiles(setFiles: (files: string[]) => void) {
    const selected = await open({ multiple: true, filters: MEDIA_FILTERS });
    if (!selected) return;
    setFiles(Array.isArray(selected) ? selected : [selected]);
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const unpaired = Math.abs(referenceFiles.length - candidateFiles.length);

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
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
    </main>
  );
}
