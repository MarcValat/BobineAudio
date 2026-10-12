import { fileURLToPath } from "node:url";

/** Where e2e/make_media.py writes the media (ignored by git). */
export const MEDIA_DIR = fileURLToPath(new URL("media", import.meta.url));

/** A media file's full path, with forward slashes (as the dev URLs take it). */
export const media = (name: string) => `${MEDIA_DIR}/${name}`.replaceAll("\\", "/");

// What make_media.py puts in them: the tests check the analyses against it.
export const DURATION = 60;
export const E01 = media("Show - E01.mkv"); // jpn, fre +1.2 s, eng -0.8 s; fre forced ass, eng srt
export const E02 = media("Show - E02.mkv"); // jpn, fre +0.5 s then +2.5 s from 30 s, eng -0.8 s
export const E03 = media("Show - E03.mkv"); // jpn, fre +0.4 s, eng -0.3 s
export const E04 = media("Show - E04.mkv"); // jpn, fre -1.0 s
export const E01_VF = media("Show - E01 (VF).mka"); // fre +0.7 s against E01's jpn
export const E02_VF = media("Show - E02 (VF).mka"); // fre +1.5 s against E02's jpn

/** The dev URL (see util.ts devParam) listing `files` in "Fichiers multipistes". */
export const multiUrl = (...files: string[]) => `/?batchFiles=${files.map(encodeURIComponent).join("|")}`;

/** The dev URL listing pairs (references and files to correct, in order). */
export const pairsUrl = (references: string[], candidates: string[]) =>
  `/?batchRef=${references.map(encodeURIComponent).join("|")}&batchCand=${candidates.map(encodeURIComponent).join("|")}`;
