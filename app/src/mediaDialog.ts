import { open, save } from "@tauri-apps/plugin-dialog";
import { pathsExist } from "./api";
import { devParam, loadSetting, saveSetting } from "./util";
import { t } from "./i18n";

// Videos to take a reference from, and the audio-only files a corrected track
// can come from (batch mode): anything ffmpeg reads is fine, these are the
// usual ones -- and what a dropped folder's files are picked by.
export const MEDIA_EXTENSIONS = [
  "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts",
  "mka", "wav", "flac", "aac", "ac3", "eac3", "dts", "thd", "mlp", "mp3", "m4a", "opus", "ogg", "wma",
];
const mediaFilters = () => [
  { name: t().files.mediaFilter, extensions: MEDIA_EXTENSIONS },
  { name: t().files.allFilter, extensions: ["*"] },
];
const LAST_FOLDER_KEY = "syncaudio.lastFolder";

// None remembered: the dialog opens wherever the system puts it.
function lastFolder(): string | undefined {
  return loadSetting(LAST_FOLDER_KEY) ?? undefined;
}

function rememberFolder(path: string): void {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut > 0) saveSetting(LAST_FOLDER_KEY, path.slice(0, cut));
}

/** The system's open dialog for media files, starting in the folder the
 * last pick came from (single file and batch mode alike). */
export async function pickMediaFiles(multiple: false): Promise<string | null>;
export async function pickMediaFiles(multiple: true): Promise<string[] | null>;
export async function pickMediaFiles(multiple: boolean): Promise<string | string[] | null> {
  const selected = await open({ multiple, filters: mediaFilters(), defaultPath: lastFolder() });
  if (!selected) return null;
  const files = Array.isArray(selected) ? selected : [selected];
  if (files.length > 0) rememberFolder(files[0]);
  return multiple ? files : files[0] ?? null;
}

/** The system's folder picker, starting at `defaultPath` when given. */
export async function pickFolder(defaultPath?: string | null): Promise<string | null> {
  const selected = await open({ directory: true, defaultPath: defaultPath ?? lastFolder() });
  return typeof selected === "string" ? selected : null;
}

function splitPath(path: string): { dir: string; stem: string } {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf("."); // "Show.S01E01.mkv" keeps its episode number
  return { dir: path.slice(0, cut + 1), stem: dot > 0 ? name.slice(0, dot) : name };
}

function joinPath(dir: string, name: string): string {
  const sep = dir === "" || dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
  return dir + sep + name;
}

/** Windows paths: case and slash direction don't matter. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Where a batch's synchronized copies go, one per input, in order. In an
 * output folder other than the original's, a copy keeps the original's name
 * ("Film.mp4" -> "Film.mkv") unless a file there already has it or another
 * copy of the batch takes it; otherwise, and next to the originals, it's
 * "Film.synced.mkv". Copies that would still share a name are numbered. */
export async function planOutputPaths(inputs: string[], outputDir: string | null): Promise<string[]> {
  const plain = inputs.map((input) => {
    const { dir, stem } = splitPath(input);
    return outputDir && !samePath(dir, outputDir) ? joinPath(outputDir, `${stem}.mkv`) : null;
  });
  const candidates = plain.filter((p): p is string => p !== null);
  const taken = await pathsExist(candidates);
  const existing = new Set(candidates.filter((_, i) => taken[i]).map((p) => p.toLowerCase()));

  const planned: string[] = [];
  const isFree = (path: string) => !planned.some((p) => samePath(p, path));
  inputs.forEach((input, i) => {
    const keep = plain[i];
    if (keep && !existing.has(keep.toLowerCase()) && isFree(keep)) {
      planned.push(keep);
      return;
    }
    const { dir, stem } = splitPath(input);
    const folder = outputDir ?? dir;
    let path = joinPath(folder, `${stem}.synced.mkv`);
    for (let n = 2; !isFree(path); n++) path = joinPath(folder, `${stem}.synced (${n}).mkv`);
    planned.push(path);
  });
  return planned;
}

/** Where `inputPath`'s synchronized copy goes, by default right next to it:
 * "Film.mkv" -> "Film.synced.mkv". */
export function syncedFileName(inputPath: string): string {
  const { dir, stem } = splitPath(inputPath);
  return dir + stem + ".synced.mkv";
}

/** The system's "save as" dialog for an exported MKV, starting at `suggestedPath`. */
export async function pickOutputFile(suggestedPath: string): Promise<string | null> {
  // Dev only (see devParam): `?saveAs=<path>` answers the dialog.
  const devPath = devParam("saveAs");
  if (devPath) return devPath;
  return save({ defaultPath: suggestedPath, filters: [{ name: "Matroska", extensions: ["mkv"] }] });
}
