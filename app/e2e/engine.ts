// The engine, asked directly by the tests (not through the page): what an
// exported file holds, and whether its corrected tracks are in sync.
import { execFileSync } from "node:child_process";

const ENGINE = "http://127.0.0.1:8756";
// The dev builds' token (see playwright.config.ts).
const HEADERS = { "X-Bobine-Token": "bobine-dev" };

export interface ProbedFile {
  tracks: { index: number; codec: string | null; language: string | null; title?: string | null; channels: number | null }[];
  subtitles: { index: number; codec: string; language: string | null; forced: boolean }[];
}

export async function probe(path: string): Promise<ProbedFile> {
  const resp = await fetch(`${ENGINE}/probe?path=${encodeURIComponent(path)}`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`probe ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/** The offsets left between `file`'s track `index` and its track
 * `reference` (the command line's analysis): ~0 once in sync. */
export function offsetsLeft(file: string, reference: number, index: number): number[] {
  const out = execFileSync(
    "uv",
    [
      "run",
      "--project",
      "../engine",
      "syncaudio",
      "segments",
      file,
      "--reference",
      String(reference),
      "--track",
      String(index),
      "--json",
      "-q",
    ],
    { encoding: "utf8", env: { ...process.env, SYNCAUDIO_CACHE_DIR: "" } },
  );
  const { segments } = JSON.parse(out) as { segments: { offset_start: number; offset_end: number }[] };
  return segments.flatMap((s) => [s.offset_start, s.offset_end]);
}

let ffmpeg: string | null = null;

/** When each line of `file`'s subtitle track `index` (among its subtitles) starts, in seconds. */
export function subtitleStarts(file: string, index: number): number[] {
  ffmpeg ??= execFileSync(
    "uv",
    ["run", "--project", "../engine", "python", "-c", "from syncaudio.ffmpeg_backend import resolve_ffmpeg; print(resolve_ffmpeg())"],
    { encoding: "utf8" },
  ).trim();
  const srt = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-map", `0:s:${index}`, "-f", "srt", "-"], { encoding: "utf8" });
  return [...srt.matchAll(/^(\d+):(\d+):(\d+),(\d+) -->/gm)].map(([, h, m, s, ms]) => +h * 3600 + +m * 60 + +s + +ms / 1000);
}
