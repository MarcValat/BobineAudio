import { useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { cancelJob, type RenderResponse, type SegmentsResponse } from "./api";
import { JobCancelled, runJob, type RunStatus } from "./jobs";
import { LogPanel } from "./LogPanel";
import { pickFolder, planOutputPaths } from "./mediaDialog";
import { basename } from "./paths";
import { describeSegments } from "./SegmentChart";
import { errorMessage, loadSetting, saveSetting } from "./util";

export function moved<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** A batch's analyze button: the items (tracks, pairs) not analyzed yet
 * when there are, keeping the others and their edits -- with a way to redo
 * everything -- or everything again once all are done. */
export function AnalyzeButton({
  analyzing,
  missing,
  analyzed,
  unit,
  disabled,
  blocked,
  onAnalyze,
}: {
  analyzing: boolean;
  missing: number;
  analyzed: number;
  /** What's counted, feminine singular: "piste", "paire". */
  unit: string;
  disabled: boolean;
  blocked: boolean;
  onAnalyze: (all: boolean) => void;
}) {
  const blockedTitle = blocked ? OTHER_MODE_BUSY : undefined;
  const redoTitle = "Réanalyse tout, y compris ce qui l'est déjà : les modifications faites avec « Modifier » sont perdues.";
  if (analyzing) {
    return (
      <button className="primary-button" disabled>
        Analyse en cours...
      </button>
    );
  }
  if (missing === 0 && analyzed > 0) {
    return (
      <button className="primary-button" disabled={disabled} title={blockedTitle ?? redoTitle} onClick={() => onAnalyze(true)}>
        Tout réanalyser
      </button>
    );
  }
  return (
    <>
      {analyzed > 0 && (
        <button className="small-button" disabled={disabled} title={blockedTitle ?? redoTitle} onClick={() => onAnalyze(true)}>
          Tout réanalyser
        </button>
      )}
      <button
        className="primary-button"
        disabled={disabled}
        title={blockedTitle ?? (analyzed > 0 ? `Analyse seulement les ${unit}s qui ne le sont pas encore ; les autres et leurs modifications sont gardées.` : undefined)}
        onClick={() => onAnalyze(false)}
      >
        {analyzed > 0 ? `Analyser ${missing > 1 ? `les ${missing} ${unit}s restantes` : `la ${unit} restante`}` : "Analyser tout"}
      </button>
    </>
  );
}

/** Why a batch mode's buttons are off while the other mode works. */
export const OTHER_MODE_BUSY = "Un traitement est en cours dans l'autre mode batch : attends sa fin.";

/** Under what's dropped on a batch mode. */
export const FOLDER_DROP_HINT = "Un dossier ajoute ses fichiers vidéo et audio, par ordre de nom";

/** Why files can't be dropped on a batch mode right now, if they can't:
 * like its "+ Ajouter" buttons, not while it or the other mode works. */
export function dropBlockedReason(busy: boolean, blocked: boolean): string | null {
  if (busy) return "Import impossible pendant une analyse ou un export : attends sa fin.";
  return blocked ? OTHER_MODE_BUSY : null;
}

/** One file of a list, with the buttons that move it within its column (to
 * reorder, or pair it with another row) or drop it. A dash when its column
 * is shorter than the other one. The arrows carry U+FE0E, which asks for
 * the plain text glyph: Windows may otherwise draw them as colored emoji. */
export function FileCell({
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

const OUTPUT_DIR_KEY = "syncaudio.batchOutputDir";

/** The folder batch exports go to (null: next to each original), kept for the next session. */
export const loadOutputDir = (): string | null => loadSetting(OUTPUT_DIR_KEY);
export const saveOutputDir = (dir: string | null): void => saveSetting(OUTPUT_DIR_KEY, dir);

/** "Sortie : à côté des originaux / <dossier>", with the buttons to change it. */
export function OutputChooser({
  outputDir,
  onChange,
  disabled,
}: {
  outputDir: string | null;
  onChange: (dir: string | null) => void;
  disabled: boolean;
}) {
  return (
    <div className="batch-output">
      <span className="batch-output-label">Sortie :</span>
      <span className={outputDir ? "batch-output-dir batch-output-path" : "batch-output-dir"} title={outputDir ?? undefined}>
        {outputDir ?? "à côté des originaux"}
      </span>
      <button
        className="small-button"
        disabled={disabled}
        title="Dans un autre dossier que l'original, un export garde le nom de l'original (sauf si ce nom y est déjà pris) ; à côté de l'original, il prend le suffixe « .synced »."
        onClick={async () => {
          const dir = await pickFolder(outputDir);
          if (dir) onChange(dir);
        }}
      >
        Choisir un dossier…
      </button>
      {outputDir && (
        <button className="small-button" disabled={disabled} onClick={() => onChange(null)} title="Écrire chaque export à côté de son original">
          À côté des originaux
        </button>
      )}
    </div>
  );
}

/** One analysis, as both batch modes keep it (a corrected track of a file, a pair). */
export interface AnalysisRun {
  status: RunStatus;
  result: SegmentsResponse | null;
  error: string | null;
  log: string[];
}

/** An analysis's status for its table cell: what it's at, its result with
 * "Modifier", or why it failed; the log while it runs or once it failed. */
export function AnalysisStatus({
  run,
  busy,
  onEdit,
}: {
  run: AnalysisRun | undefined;
  busy: boolean;
  onEdit: () => void;
}) {
  if (!run) return <>À analyser</>;
  return (
    <>
      {run.status === "pending" && "En attente"}
      {run.status === "running" && "Analyse en cours..."}
      {run.status === "done" && run.result && describeSegments(run.result.segments)}
      {run.status === "error" && (run.error ?? "Erreur")}
      {run.status === "done" && run.result && (
        <button className="small-button" disabled={busy} onClick={onEdit}>
          Modifier
        </button>
      )}
      {(run.status === "running" || run.status === "error") && <LogPanel lines={run.log} />}
    </>
  );
}

/** One file's export, as both batch modes keep it. */
export interface ExportFields {
  exportStatus: RunStatus;
  exportResult: RenderResponse | null;
  exportError: string | null;
  exportLog: string[];
}

export const IDLE_EXPORT: ExportFields = { exportStatus: "idle", exportResult: null, exportError: null, exportLog: [] };

/** The file an export wrote, once done. */
export const writtenFile = (entry: ExportFields | undefined | null): string | undefined => entry?.exportResult?.written[0];

/** The "Export" cell: dash, progress, the written file, the error or "Annulé". */
export function ExportCell({ entry }: { entry: ExportFields | undefined | null }) {
  const status = entry?.exportStatus ?? "idle";
  const written = writtenFile(entry);
  return (
    <td className={`batch-status batch-status-${status === "idle" ? "pending" : status}`}>
      {status === "idle" && "—"}
      {status === "running" && "Export en cours..."}
      {status === "done" && written && <span title={written}>{basename(written)}</span>}
      {status === "error" && (entry?.exportError ?? "Erreur")}
      {status === "cancelled" && "Annulé"}
      {entry && (status === "running" || status === "error") && <LogPanel lines={entry.exportLog} />}
    </td>
  );
}

/** The row's "Dossier" button, once its export is written. */
export function RevealButton({ file }: { file: string | undefined }) {
  if (!file) return null;
  return (
    <button className="small-button" title="Ouvrir le dossier du fichier écrit" onClick={() => revealItemInDir(file)}>
      Dossier
    </button>
  );
}

/** One file to export: `input` names the output (see planOutputPaths),
 * `start` starts its render job at the given output path, `update` records
 * its progress in the mode's own state. */
export interface ExportTask {
  input: string;
  start: (outputPath: string) => Promise<string>;
  update: (patch: (entry: ExportFields) => Partial<ExportFields>) => void;
}

/** "Exporter tout" / "Annuler l'export", the same in both batch modes: the
 * output names are decided up front, then one render at a time; cancelling
 * stops the one running (the engine kills it and removes its half-written
 * file) and doesn't start the next ones. */
export function useExportQueue(outputDir: string | null) {
  const [exporting, setExporting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  const currentJob = useRef<string | null>(null);

  async function run(tasks: ExportTask[]) {
    setExporting(true);
    cancelRequested.current = false;
    try {
      let outputs: string[];
      try {
        outputs = await planOutputPaths(tasks.map((t) => t.input), outputDir);
      } catch (err) {
        const message = errorMessage(err);
        for (const t of tasks) t.update(() => ({ exportStatus: "error", exportError: message }));
        return;
      }
      for (const [k, task] of tasks.entries()) {
        if (cancelRequested.current) break;
        task.update(() => ({ exportStatus: "running", exportLog: [], exportError: null }));
        try {
          const result = await runJob<RenderResponse>(
            task.start(outputs[k]),
            (message) => task.update((e) => ({ exportLog: [...e.exportLog, message] })),
            (id) => (currentJob.current = id),
          );
          task.update(() => ({ exportStatus: "done", exportResult: result }));
        } catch (err) {
          if (err instanceof JobCancelled) task.update(() => ({ exportStatus: "cancelled" }));
          else task.update(() => ({ exportStatus: "error", exportError: errorMessage(err) }));
        }
        currentJob.current = null;
      }
    } finally {
      setExporting(false);
      setCancelling(false);
    }
  }

  async function cancel() {
    cancelRequested.current = true;
    setCancelling(true);
    if (currentJob.current) {
      try {
        await cancelJob(currentJob.current);
      } catch {
        // already over: the queue stops before the next file anyway
      }
    }
  }

  return { exporting, cancelling, run, cancel };
}

/** A batch mode's footer: output folder, progress line, analyze and export
 * (or cancel) buttons. */
export function BatchFooter({
  outputDir,
  onOutputDirChange,
  busy,
  blocked,
  progress,
  analyzeButton,
  queue,
  canExport,
  onExport,
}: {
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  busy: boolean;
  blocked: boolean;
  progress: ReactNode;
  analyzeButton: ReactNode;
  queue: ReturnType<typeof useExportQueue>;
  canExport: boolean;
  onExport: () => void;
}) {
  return (
    <div className="batch-footer panel">
      <OutputChooser outputDir={outputDir} onChange={onOutputDirChange} disabled={busy} />
      <span className="batch-progress">{progress}</span>
      {analyzeButton}
      {queue.exporting ? (
        <button className="export-cancel" onClick={queue.cancel} disabled={queue.cancelling}>
          {queue.cancelling ? "Annulation..." : "Annuler l'export"}
        </button>
      ) : (
        <button
          className="primary-button"
          onClick={onExport}
          disabled={!canExport || busy || blocked}
          title={blocked ? OTHER_MODE_BUSY : undefined}
        >
          Exporter tout
        </button>
      )}
    </div>
  );
}
