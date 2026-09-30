import type { SubtitleInfo } from "./api";
import { t } from "./i18n";

/** Which subtitle tracks go with a corrected audio track, retimed along with
 * it: its language's forced ones (only the lines the audio doesn't cover --
 * signs, a foreign-language line -- so timed on that audio), all of its
 * language, or none. */
export type SubtitleMode = "forced" | "all" | "none";

/** In the order the setting lists them (labels: Messages.subtitles.modes). */
export const SUBTITLE_MODES: SubtitleMode[] = ["forced", "all", "none"];

/** The subtitle tracks to retime with an audio track in `language`, by
 * `mode`. Image subtitles (PGS, VobSub) are left out: they can't be
 * retimed segment by segment. */
export function subtitlesFor(subtitles: SubtitleInfo[], language: string | null, mode: SubtitleMode = "forced"): number[] {
  if (mode === "none" || !language) return [];
  return subtitles
    .filter((s) => s.shiftable && s.language === language && (mode === "all" || s.forced))
    .map((s) => s.index);
}

/** "@4 fre forcés « Français (forcé) »". */
export function subtitleLabel(s: SubtitleInfo): string {
  const m = t().subtitles;
  return `@${s.index} ${s.language ?? "?"}${s.forced ? m.forcedTag : ""}${s.title ? ` ${m.quoted(s.title)}` : ""}`;
}

/** What a subtitle track is, for a tooltip: "Format ass · sous-titres forcés · titre « ... »". */
export function subtitleDetails(s: SubtitleInfo): string {
  const m = t().subtitles;
  const parts = [m.format(s.codec), s.forced ? m.forced : m.full];
  if (s.title) parts.push(m.titled(s.title));
  return parts.join(" · ");
}

/** Which subtitle tracks go with each audio track (by its index): one
 * subtitle track goes with one audio track at most, so in `tracks`' order,
 * each takes those of `wanted(track)` no earlier one took. */
export function assignSubtitles<T extends { index: number }>(tracks: T[], wanted: (track: T) => number[]): Record<number, number[]> {
  const claimed = new Set<number>();
  const out: Record<number, number[]> = {};
  for (const t of tracks) {
    out[t.index] = wanted(t).filter((i) => !claimed.has(i));
    out[t.index].forEach((i) => claimed.add(i));
  }
  return out;
}

/** The subtitle tracks assigned to other audio tracks than `track`. */
export function takenByOthers(assigned: Record<number, number[]>, track: number): number[] {
  return Object.entries(assigned).flatMap(([other, subs]) => (Number(other) === track ? [] : subs));
}
