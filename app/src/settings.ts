import { useEffect, useState, useSyncExternalStore } from "react";
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
 * the starting setting of both modes. */
function loadSubtitleDefault(): SubtitleMode {
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

/** A mode's own subtitle pick: it starts as the default setting, and
 * follows it when it changes in Paramètres. */
export function useSubtitleMode(): [SubtitleMode, (mode: SubtitleMode) => void] {
  const subtitleDefault = useSubtitleDefault();
  const [mode, setMode] = useState(subtitleDefault);
  useEffect(() => setMode(subtitleDefault), [subtitleDefault]);
  return [mode, setMode];
}

/** Whether the app looks for an update on GitHub at startup (the default). */
function loadCheckUpdates(): boolean {
  return loadSetting(CHECK_UPDATES_KEY) !== "0";
}

export function saveCheckUpdates(check: boolean): void {
  saveSetting(CHECK_UPDATES_KEY, check ? null : "0");
  changed();
}

export function useCheckUpdates(): boolean {
  return useSyncExternalStore(subscribe, loadCheckUpdates);
}

const LIST_COLLAPSED_KEY = "syncaudio.listCollapsed";

/** Whether the file list is folded to a narrow column (both modes). */
function loadListCollapsed(): boolean {
  return loadSetting(LIST_COLLAPSED_KEY) === "1";
}

export function saveListCollapsed(collapsed: boolean): void {
  saveSetting(LIST_COLLAPSED_KEY, collapsed ? "1" : null);
  changed();
}

export function useListCollapsed(): boolean {
  return useSyncExternalStore(subscribe, loadListCollapsed);
}

/** The codec corrected tracks are exported in: "auto" matches each one's
 * source (AAC -> Opus, DTS/TrueHD -> FLAC, see the engine's render.py). */
export type ExportCodec = "auto" | "opus" | "aac" | "flac" | "ac3" | "eac3";
export const EXPORT_CODECS: ExportCodec[] = ["auto", "opus", "aac", "flac", "ac3", "eac3"];

/** How a corrected track is named in the export: its source's name, one
 * made of its properties ("FR Opus 2.0"), or one typed in per language. */
export type TrackNaming = "source" | "auto" | "custom";
export const TRACK_NAMINGS: TrackNaming[] = ["source", "auto", "custom"];

const EXPORT_CODEC_KEY = "syncaudio.exportCodec";
const TRACK_NAMING_KEY = "syncaudio.trackNaming";

function loadExportCodec(): ExportCodec {
  const saved = loadSetting(EXPORT_CODEC_KEY) as ExportCodec | null;
  return saved && EXPORT_CODECS.includes(saved) ? saved : "auto";
}

export function saveExportCodec(codec: ExportCodec): void {
  saveSetting(EXPORT_CODEC_KEY, codec === "auto" ? null : codec);
  changed();
}

export function useExportCodec(): ExportCodec {
  return useSyncExternalStore(subscribe, loadExportCodec);
}

function loadTrackNaming(): TrackNaming {
  const saved = loadSetting(TRACK_NAMING_KEY) as TrackNaming | null;
  return saved && TRACK_NAMINGS.includes(saved) ? saved : "source";
}

export function saveTrackNaming(naming: TrackNaming): void {
  saveSetting(TRACK_NAMING_KEY, naming === "source" ? null : naming);
  changed();
}

export function useTrackNaming(): TrackNaming {
  return useSyncExternalStore(subscribe, loadTrackNaming);
}
