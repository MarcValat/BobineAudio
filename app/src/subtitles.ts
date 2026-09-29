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
