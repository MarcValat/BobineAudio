import { test as base, expect, type Page } from "@playwright/test";
import { readdirSync, rmSync } from "node:fs";
import { MEDIA_DIR } from "./media";

declare global {
  interface Window {
    __audio: { sources: Set<AudioBufferSourceNode & { __ended?: boolean }>; max: number; contexts: number; durations?: number[] };
    __activeSources: () => number;
  }
}

/** Web Audio watched: the clips started, how many play at once (never more
 * than the three of a listening), how long each lasts. */
function instrument() {
  type Source = AudioBufferSourceNode & { __ended?: boolean };
  const sources = new Set<Source>();
  window.__audio = { sources, max: 0, contexts: 0 };
  const active = () => [...sources].filter((s) => !s.__ended && s.context.state === "running").length;
  window.__activeSources = active;
  const proto = AudioBufferSourceNode.prototype as Source;
  const start = proto.start;
  const stop = proto.stop;
  // Stopped at once (stop() with no time): silent from now, whatever the
  // "ended" event's own timing.
  proto.stop = function (this: Source, when?: number) {
    if (when === undefined || when <= this.context.currentTime) this.__ended = true;
    return stop.call(this, when);
  };
  proto.start = function (this: Source, ...args: Parameters<AudioBufferSourceNode["start"]>) {
    sources.add(this);
    (window.__audio.durations ??= []).push(Math.round((this.buffer?.duration ?? 0) * 100) / 100);
    this.addEventListener("ended", () => (this.__ended = true));
    const r = start.apply(this, args);
    window.__audio.max = Math.max(window.__audio.max, active());
    return r;
  };
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...a: ConstructorParameters<typeof AudioContext>) {
      super(...a);
      window.__audio.contexts++;
    }
  };
}

/** A segment as the engine reports it. */
export interface Segment {
  start_s: number;
  end_s: number;
  offset_start: number;
  offset_end: number;
  is_drift: boolean;
  confidence: number;
}

/** What the engine's jobs answered, read from their WebSocket: each
 * analysis by its track ("path@index"), each export's written files. */
export class Jobs {
  readonly analyses = new Map<string, Segment[]>();
  readonly written: string[] = [];

  watch(page: Page) {
    page.on("websocket", (ws) =>
      ws.on("framereceived", ({ payload }) => {
        const event = JSON.parse(String(payload));
        if (event.type !== "done" || !event.result) return;
        if (event.result.segments && event.result.track) this.analyses.set(event.result.track, event.result.segments);
        if (event.result.written) this.written.push(...event.result.written);
      }),
    );
  }

  /** The segments found for `file`'s track `index`. */
  segments(file: string, index: number): Segment[] {
    const found = this.analyses.get(`${file}@${index}`);
    if (!found) throw new Error(`no analysis of ${file}@${index} (have: ${[...this.analyses.keys()].join(", ")})`);
    return found;
  }
}

/** What a test drives the app with: its page, and the usual gestures. */
export class App {
  readonly jobs = new Jobs();

  constructor(readonly page: Page) {
    this.jobs.watch(page);
  }

  /** The detail's Analyser, once the file's tracks are read; done once the
   * results show. */
  async analyze() {
    const analyze = this.page.locator(".detail-header button", { hasText: /^(Analyser|Analyze)$/ });
    await expect(analyze).toBeEnabled({ timeout: 120_000 });
    await analyze.click();
    await this.page.getByRole("button", { name: /Modifier les segments|Edit segments/ }).waitFor({ timeout: 300_000 });
    await this.page.locator(".detail-body .waveform-svg").first().waitFor({ timeout: 60_000 });
    await this.page.waitForTimeout(300);
  }

  /** The footer's gradient button (Analyser tout, Exporter tout…). */
  footerPrimary() {
    return this.page.locator(".batch-footer .primary-button");
  }

  /** Every listed file analyzed, from the footer. */
  async analyzeAll() {
    await expect(this.footerPrimary()).toBeEnabled({ timeout: 120_000 });
    await this.footerPrimary().click();
    await expect(this.page.locator(".list-row .list-badge").filter({ hasText: /^Analysée?( ·|$)/ })).toHaveCount(
      await this.rows().count(),
      {
        timeout: 300_000,
      },
    );
  }

  rows() {
    return this.page.locator(".list-row");
  }

  play(scope: string) {
    return this.page.locator(`${scope} .preview-play`).click();
  }

  label(scope: string) {
    return this.page.locator(`${scope} .preview-play`).textContent();
  }

  async playing(scope: string, timeout = 30_000) {
    await expect(this.page.locator(`${scope} .preview-play`)).toHaveText(/Arrêter|Stop/, { timeout });
  }

  async stopped(scope: string, timeout = 10_000) {
    await expect(this.page.locator(`${scope} .preview-play`)).toHaveText(/Écouter|Listen/, { timeout });
  }

  /** How many clips play now, and at most so far. */
  active() {
    return this.page.evaluate(() => window.__activeSources());
  }

  maxActive() {
    return this.page.evaluate(() => window.__audio.max);
  }

  /** The clips of the last start, in play order: reference, the track as it
   * is, the result. */
  lastDurations() {
    return this.page.evaluate(() => (window.__audio.durations ?? []).slice(-3));
  }

  cursor(scope: string) {
    return this.page.evaluate((s) => {
      const el = [...document.querySelectorAll(`${s} .waveform-cursor`)].find((e) => e.getClientRects().length);
      return el ? el.getBoundingClientRect().left : null;
    }, scope);
  }

  async position(scope: string) {
    return Number(await this.page.locator(`${scope} .preview-controls input[type=number]`).inputValue());
  }

  setPosition(scope: string, value: number | string) {
    return this.page.locator(`${scope} .preview-controls input[type=number]`).fill(String(value));
  }

  async waveformBox(scope: string, i = 1) {
    const box = await this.page.locator(`${scope} .waveform-svg`).nth(i).boundingBox();
    if (!box) throw new Error("no waveform");
    return box;
  }

  /** A click on the waveform at `share` of its width (the whole track shown). */
  async clickWaveform(scope: string, share: number) {
    const box = await this.waveformBox(scope);
    await this.page.mouse.click(box.x + box.width * share, box.y + box.height / 2);
  }

  async openEditor() {
    await this.page.getByRole("button", { name: /Modifier les segments|Edit segments/ }).click();
    await this.page.locator(".editor-preview .waveform-svg").first().waitFor({ timeout: 60_000 });
    await this.page.waitForTimeout(300);
  }

  cancelEditor() {
    return this.page
      .locator(".editor-panel")
      .getByRole("button", { name: /^(Annuler|Cancel)$/ })
      .click();
  }
}

/** Every test fails on an engine error (HTTP 4xx/5xx), a page error, a
 * console error or an export left next to the media, besides its own checks. */
export const test = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("response", async (r) => {
      if (r.status() >= 400) {
        const body = await r.text().catch(() => "");
        problems.push(`HTTP ${r.status()} ${r.url().split("?")[0].split("/").pop()} ${body.slice(0, 160)}`);
      }
    });
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
    });
    await page.addInitScript(instrument);
    await use(new App(page));
    // An export next to the media (the output folder not set in time):
    // removed, and failed.
    const strays = readdirSync(MEDIA_DIR).filter((name) => name.includes(".synced"));
    for (const name of strays) rmSync(`${MEDIA_DIR}/${name}`);
    expect(strays, "exports written next to the media").toEqual([]);
    expect(problems, "engine, page or console errors").toEqual([]);
  },
});

export { expect };

/** The detail, and the segment editor's preview. */
export const D = ".detail-body";
export const E = ".editor-preview";
