import { useSyncExternalStore } from "react";
import type { SubtitleMode } from "./subtitles";
import { loadSetting, saveSetting } from "./util";

// Options' settings, remembered across sessions; a view using one follows
// a change made in Options right away.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  listeners.forEach((listener) => listener());
}

const SUBTITLE_DEFAULT_KEY = "syncaudio.subtitleDefault";
const CHECK_UPDATES_KEY = "syncaudio.checkUpdates";

/** Which subtitle tracks go with a corrected track unless picked otherwise:
 * ticked in single-file mode, the batch modes' starting setting. */
export function loadSubtitleDefault(): SubtitleMode {
  const saved = loadSetting(SUBTITLE_DEFAULT_KEY);
  return saved === "all" || saved === "none" ? saved : "forced";
}

export function saveSubtitleDefault(mode: SubtitleMode): void {
  saveSetting(SUBTITLE_DEFAULT_KEY, mode === "forced" ? null : mode);
  changed();
}

export function useSubtitleDefault(): SubtitleMode {
  return useSyncExternalStore(subscribe, loadSubtitleDefault);
}

/** Whether the app looks for an update on GitHub at startup (the default). */
export function loadCheckUpdates(): boolean {
  return loadSetting(CHECK_UPDATES_KEY) !== "0";
}

export function saveCheckUpdates(check: boolean): void {
  saveSetting(CHECK_UPDATES_KEY, check ? null : "0");
  changed();
}

export function useCheckUpdates(): boolean {
  return useSyncExternalStore(subscribe, loadCheckUpdates);
}
