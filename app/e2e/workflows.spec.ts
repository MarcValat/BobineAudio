// Both modes from start to finish: the files listed, analyzed (the offsets
// found where make_media.py put them), exported with the export options
// picked in their dialog -- the export then read back: its tracks, their
// names and codecs, and its corrected tracks in sync. Exports go to a
// temporary folder, removed after.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetsLeft, probe, subtitleStarts } from "./engine";
import { expect, test, type App, type Segment } from "./fixtures";
import { E01, E01_VF, E02, E02_VF, E03, multiUrl, pairsUrl } from "./media";

/** Within 50 ms of what was put in (the analysis finds them within ~25). */
const TOLERANCE = 0.05;

function expectConstant(segments: Segment[], offset: number) {
  expect(segments, JSON.stringify(segments)).toHaveLength(1);
  expect(Math.abs(segments[0].offset_start - offset)).toBeLessThan(TOLERANCE);
  expect(Math.abs(segments[0].offset_end - offset)).toBeLessThan(TOLERANCE);
}

let outDir: string;

test.beforeEach(async ({ app }) => {
  outDir = mkdtempSync(join(tmpdir(), "bobine-e2e-out-"));
  await app.page.addInitScript((dir) => localStorage.setItem("syncaudio.batchOutputDir", dir), outDir.replaceAll("\\", "/"));
});

test.afterEach(() => rmSync(outDir, { recursive: true, force: true }));

/** The export options set in their dialog, from the footer's "Modifier…". */
async function setExportOptions(app: App, codec: string, naming: string) {
  await app.page.getByRole("button", { name: "Modifier…" }).click();
  const dialog = app.page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Codec audio" }).click();
  await app.page.getByRole("option", { name: codec }).click();
  await dialog.getByRole("tab", { name: naming }).click();
  await app.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("multitrack files: every offset found, a file exported in sync, its tracks named", async ({ app }) => {
  await app.page.goto(multiUrl(E01, E02, E03));
  await expect(app.rows()).toHaveCount(3);
  await app.analyzeAll();

  expectConstant(app.jobs.segments(E01, 1), 1.2);
  expectConstant(app.jobs.segments(E01, 2), -0.8);
  expectConstant(app.jobs.segments(E03, 1), 0.4);
  expectConstant(app.jobs.segments(E03, 2), -0.3);
  // The jump: +0.5 s, then +2.5 s from about 30 s.
  const jump = app.jobs.segments(E02, 1);
  expect(jump, JSON.stringify(jump)).toHaveLength(2);
  expect(Math.abs(jump[0].offset_end - 0.5)).toBeLessThan(TOLERANCE);
  expect(Math.abs(jump[1].offset_start - 2.5)).toBeLessThan(TOLERANCE);
  expect(Math.abs(jump[1].start_s - 30)).toBeLessThan(1);

  // Analyzed: the next step is the export.
  await expect(app.footerPrimary()).toHaveText("Exporter tout");
  await expect(app.page.locator(".batch-footer")).toContainText("Export : ");

  await setExportOptions(app, "FLAC (sans perte)", "Automatique");
  await expect(app.page.locator(".batch-output-format")).toContainText("FLAC · noms automatiques");
  // The detail shows the names they'll get.
  await app.rows().first().click();
  await expect(app.page.locator(".detail-name-row input").first()).toHaveAttribute("placeholder", "FR FLAC 2.0");

  await app.page.getByRole("button", { name: "Exporter ce fichier" }).click();
  await expect(app.rows().first().locator(".list-badge")).toHaveText("Exporté", { timeout: 120_000 });
  expect(app.jobs.written).toHaveLength(1);
  const written = app.jobs.written[0];
  expect(written.replaceAll("\\", "/")).toBe(`${outDir.replaceAll("\\", "/")}/Show - E01.mkv`);

  const out = await probe(written);
  expect(out.tracks.map((t) => [t.language, t.codec, t.title])).toEqual([
    ["jpn", "aac (LC)", "Japonais"],
    ["fre", "flac", "FR FLAC 2.0"],
    ["eng", "flac", "EN FLAC 2.0"],
  ]);
  // Its forced French subtitles retimed with the French track (1.2 s
  // earlier), the English ones copied as they are -- compared to the same
  // reading of the original (ffmpeg's reading shifts both by its start).
  expect(out.subtitles.map((s) => [s.language, s.forced]).sort()).toEqual([
    ["eng", false],
    ["fre", true],
  ]);
  const fre = out.subtitles.findIndex((s) => s.language === "fre");
  const [originalFre, originalEng] = [subtitleStarts(E01, 0)[0], subtitleStarts(E01, 1)[0]];
  expect(Math.abs(subtitleStarts(written, fre)[0] - (originalFre - 1.2))).toBeLessThan(TOLERANCE);
  expect(Math.abs(subtitleStarts(written, 1 - fre)[0] - originalEng)).toBeLessThan(0.01);
  for (const index of [1, 2]) for (const left of offsetsLeft(written, 0, index)) expect(Math.abs(left)).toBeLessThan(TOLERANCE);
});

test("pairs: every offset found, a pair exported in sync", async ({ app }) => {
  await app.page.goto(pairsUrl([E01, E02], [E01_VF, E02_VF]));
  await expect(app.rows()).toHaveCount(2);
  await app.analyzeAll();

  expectConstant(app.jobs.segments(E01_VF, 0), 0.7);
  expectConstant(app.jobs.segments(E02_VF, 0), 1.5);
  await expect(app.footerPrimary()).toHaveText("Exporter tout");

  await setExportOptions(app, "Opus", "Automatique");
  await app.rows().first().click();
  await app.page.getByRole("button", { name: "Exporter cette paire" }).click();
  await expect(app.rows().first().locator(".list-badge")).toHaveText("Exportée", { timeout: 120_000 });
  const written = app.jobs.written[0];

  const out = await probe(written);
  expect(out.tracks.map((t) => [t.language, t.codec, t.title])).toEqual([
    ["jpn", "aac (LC)", "Japonais"],
    ["fre", "opus", "FR Opus 2.0"],
  ]);
  for (const left of offsetsLeft(written, 0, 1)) expect(Math.abs(left)).toBeLessThan(TOLERANCE);
});

test("export all: every file written, the footer says so", async ({ app }) => {
  await app.page.goto(multiUrl(E01, E03));
  await app.analyzeAll();
  await expect(app.footerPrimary()).toHaveText("Exporter tout");
  await app.footerPrimary().click();
  await expect(app.rows().locator(".list-badge").filter({ hasText: "Exporté" })).toHaveCount(2, { timeout: 180_000 });
  expect(app.jobs.written.map((w) => w.replaceAll("\\", "/").split("/").pop()).sort()).toEqual(["Show - E01.mkv", "Show - E03.mkv"]);
  // All done: no next step left.
  await expect(app.footerPrimary()).toHaveCount(0);
});
