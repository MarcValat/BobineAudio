import type { SubtitleInfo } from "./api";

/** Which subtitle tracks go with a corrected audio track, retimed along with
 * it: its language's forced ones (only the lines the audio doesn't cover --
 * signs, a foreign-language line -- so timed on that audio), all of its
 * language, or none. */
export type SubtitleMode = "forced" | "all" | "none";

export const SUBTITLE_MODES: { value: SubtitleMode; label: string }[] = [
  { value: "forced", label: "Forcés de même langue" },
  { value: "all", label: "Tous de même langue" },
  { value: "none", label: "Aucun" },
];

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
  return `@${s.index} ${s.language ?? "?"}${s.forced ? " forcés" : ""}${s.title ? ` « ${s.title} »` : ""}`;
}

/** What a subtitle track is, for a tooltip: "Format ass · sous-titres forcés · titre « ... »". */
export function subtitleDetails(s: SubtitleInfo): string {
  const parts = [`Format ${s.codec}`, s.forced ? "sous-titres forcés" : "sous-titres complets"];
  if (s.title) parts.push(`titre « ${s.title} »`);
  return parts.join(" · ");
}

export const UNSHIFTABLE_HINT =
  "Sous-titres image (PGS, VobSub) : ils ne peuvent pas être recalés segment par segment, seuls les sous-titres texte (SRT, ASS) le peuvent.";

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
