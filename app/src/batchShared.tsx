import { connectJobWS } from "./api";
import { pickFolder } from "./mediaDialog";
import { basename } from "./paths";

export function moved<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Promise wrapper around the callback-based connectJobWS -- needed in batch
 * mode (unlike the single-file view) because files run one after another
 * and each must be awaited before the next starts, rather than all firing
 * concurrently: a batch can be many episodes, and each analysis is already
 * CPU-heavy across every core on its own (see analysis_cache/features.py),
 * so running several at once would oversubscribe cores instead of
 * finishing sooner. Renders are lighter, but kept sequential too, for the
 * same predictable one-at-a-time progress and to avoid writing several
 * large output files to disk at once. */
export function runJob<T>(jobId: Promise<string>, onLog: (message: string) => void): Promise<T> {
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

export type RunStatus = "idle" | "pending" | "running" | "done" | "error";

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

// ISO 639-2 codes, as Matroska tags tracks with them.
const LANGUAGE_NAMES: Record<string, string> = {
  fre: "Français",
  eng: "Anglais",
  jpn: "Japonais",
  ger: "Allemand",
  spa: "Espagnol",
  ita: "Italien",
  por: "Portugais",
  dut: "Néerlandais",
  rus: "Russe",
  pol: "Polonais",
  kor: "Coréen",
  chi: "Chinois",
  ara: "Arabe",
  swe: "Suédois",
  nor: "Norvégien",
  dan: "Danois",
  fin: "Finnois",
  tur: "Turc",
  heb: "Hébreu",
  hin: "Hindi",
  tha: "Thaï",
  vie: "Vietnamien",
};

/** "Français (fre)", or the bare code for one not in the list above. */
export function languageLabel(code: string | null): string {
  if (!code) return "sans langue";
  const name = LANGUAGE_NAMES[code];
  return name ? `${name} (${code})` : code;
}

/** A language picker: the ones the files at hand use (`extra`), plus the
 * usual ones unless `onlyExtra` -- to pick among what's there, not to tag
 * a track with a new one. `emptyLabel` names the "" choice (keep the
 * track's own, pick none...). */
export function LanguageSelect({
  value,
  onChange,
  extra = [],
  onlyExtra = false,
  emptyLabel,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  extra?: (string | null)[];
  onlyExtra?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const found = extra.filter((c): c is string => !!c);
  const codes = [...new Set(onlyExtra ? found : [...found, ...Object.keys(LANGUAGE_NAMES)])];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {codes.map((code) => (
        <option key={code} value={code}>
          {languageLabel(code)}
        </option>
      ))}
    </select>
  );
}

const OUTPUT_DIR_KEY = "syncaudio.batchOutputDir";

/** The folder batch exports go to (null: next to each original), kept for
 * the next session. Browser storage can fail: the choice then just isn't
 * remembered. */
export function loadOutputDir(): string | null {
  try {
    return localStorage.getItem(OUTPUT_DIR_KEY);
  } catch {
    return null;
  }
}

export function saveOutputDir(dir: string | null): void {
  try {
    if (dir) localStorage.setItem(OUTPUT_DIR_KEY, dir);
    else localStorage.removeItem(OUTPUT_DIR_KEY);
  } catch {
    // not remembered this time
  }
}

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
      <span className="batch-output-dir" title={outputDir ?? undefined}>
        {outputDir ?? "à côté des originaux"}
      </span>
      <button
        className="small-button"
        disabled={disabled}
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
