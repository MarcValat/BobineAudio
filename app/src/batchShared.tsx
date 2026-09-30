import { pickFolder } from "./mediaDialog";
import { basename } from "./paths";
import { loadSetting, saveSetting } from "./util";

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
