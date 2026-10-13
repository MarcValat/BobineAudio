// The segment editor on a track with a jump (E02's French: +0.5 s, then
// +2.5 s from 30 s): cut, remove, undo / redo, reset, the unsaved changes'
// question, and what's saved being what's exported.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetsLeft } from "./engine";
import { expect, test, type App } from "./fixtures";
import { E02, multiUrl } from "./media";

const rows = (app: App) => app.page.locator(".editor-table tbody tr");
const editor = (app: App) => app.page.getByRole("dialog", { name: "Corriger les segments" });

/** A double click on the chart at `share` of its width: a cut there. */
async function cutAt(app: App, share: number) {
  const box = await app.page.locator(".editor-chart").boundingBox();
  if (!box) throw new Error("no chart");
  await app.page.mouse.dblclick(box.x + box.width * share, box.y + box.height / 2);
}

let outDir: string;

test.beforeEach(async ({ app }) => {
  // Exports go to a temporary folder (read by the app as it starts).
  outDir = mkdtempSync(join(tmpdir(), "bobine-e2e-out-"));
  await app.page.addInitScript((dir) => localStorage.setItem("syncaudio.batchOutputDir", dir), outDir.replaceAll("\\", "/"));
  await app.page.goto(multiUrl(E02));
  await app.analyze();
  await app.openEditor();
  await expect(rows(app)).toHaveCount(2);
});

test.afterEach(() => rmSync(outDir, { recursive: true, force: true }));

test("cut, undo, redo, reset", async ({ app }) => {
  await cutAt(app, 0.25);
  await expect(rows(app)).toHaveCount(3);
  await app.page.keyboard.press("Control+z");
  await expect(rows(app)).toHaveCount(2);
  await app.page.keyboard.press("Control+y");
  await expect(rows(app)).toHaveCount(3);
  await editor(app).getByRole("button", { name: "Défaire" }).click();
  await expect(rows(app)).toHaveCount(2);
  await editor(app).getByRole("button", { name: "Refaire" }).click();
  await expect(rows(app)).toHaveCount(3);
  await editor(app).getByRole("button", { name: "Réinitialiser" }).click();
  await expect(rows(app)).toHaveCount(2);
});

test("closing with unsaved changes asks first", async ({ app }) => {
  await cutAt(app, 0.25);
  await app.page.keyboard.press("Escape");
  await expect(app.page.getByText("Abandonner les modifications non enregistrées ?")).toBeVisible();
  await app.page.getByRole("button", { name: "Continuer l'édition" }).click();
  await expect(rows(app)).toHaveCount(3);
  await app.page.keyboard.press("Escape");
  await app.page.getByRole("button", { name: "Abandonner" }).click();
  await expect(editor(app)).toBeHidden();
  // Nothing kept: the detail still has its two segments.
  await expect(app.page.locator(".detail-body")).toContainText("2 segments");
});

test("what's saved is what's exported", async ({ app }) => {
  // The jump removed: the first segment's +0.5 s stretches over the whole track.
  await rows(app).nth(1).getByRole("button", { name: "Retirer" }).click();
  await expect(rows(app)).toHaveCount(1);
  await editor(app).getByRole("button", { name: "Enregistrer" }).click();
  await expect(editor(app)).toBeHidden();
  await expect(app.page.locator(".detail-body")).toContainText("1 segment");

  await app.page.getByRole("button", { name: "Exporter ce fichier" }).click();
  await expect(app.rows().first().locator(".list-badge")).toHaveText("Exporté", { timeout: 120_000 });
  const written = app.jobs.written[0];
  expect(written.replaceAll("\\", "/")).toBe(`${outDir.replaceAll("\\", "/")}/Show - E02.mkv`);
  // In sync before the jump, 2 s off after it: the saved segments were used.
  const left = offsetsLeft(written, 0, 1);
  expect(left.some((o) => Math.abs(o) < 0.05)).toBe(true);
  expect(left.some((o) => Math.abs(o - 2) < 0.05)).toBe(true);
});
