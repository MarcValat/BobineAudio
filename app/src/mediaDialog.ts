import { open, save } from "@tauri-apps/plugin-dialog";

const MEDIA_FILTERS = [{ name: "Vidéo/Audio", extensions: ["mkv", "mp4", "wav", "flac", "aac", "mp3"] }];
const LAST_FOLDER_KEY = "syncaudio.lastFolder";

// Browser storage can be unavailable or throw: the dialog then just opens
// wherever the system puts it, as before.
function lastFolder(): string | undefined {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberFolder(path: string): void {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut <= 0) return;
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path.slice(0, cut));
  } catch {
    // not remembered this time, nothing else depends on it
  }
}

/** The system's open dialog for media files, starting in the folder the
 * last pick came from (single file and batch mode alike). */
export async function pickMediaFiles(multiple: false): Promise<string | null>;
export async function pickMediaFiles(multiple: true): Promise<string[] | null>;
export async function pickMediaFiles(multiple: boolean): Promise<string | string[] | null> {
  const selected = await open({ multiple, filters: MEDIA_FILTERS, defaultPath: lastFolder() });
  if (!selected) return null;
  const files = Array.isArray(selected) ? selected : [selected];
  if (files.length > 0) rememberFolder(files[0]);
  return multiple ? files : files[0] ?? null;
}

/** Where `inputPath`'s synchronized copy goes, by default right next to it:
 * "Film.mkv" -> "Film.synced.mkv". */
export function syncedFileName(inputPath: string): string {
  const cut = Math.max(inputPath.lastIndexOf("\\"), inputPath.lastIndexOf("/"));
  const name = inputPath.slice(cut + 1);
  const dot = name.lastIndexOf("."); // "Show.S01E01.mkv" keeps its episode number
  return inputPath.slice(0, cut + 1) + (dot > 0 ? name.slice(0, dot) : name) + ".synced.mkv";
}

/** The system's "save as" dialog for an exported MKV, starting at `suggestedPath`. */
export async function pickOutputFile(suggestedPath: string): Promise<string | null> {
  return save({ defaultPath: suggestedPath, filters: [{ name: "Matroska", extensions: ["mkv"] }] });
}
