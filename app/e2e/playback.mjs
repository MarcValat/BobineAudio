// Listening (Écouter) end-to-end tests: each scenario drives the app in a
// browser and watches the engine's error responses, the page's errors, and
// the audio sources really playing (Web Audio patched): never more than the
// three clips at once, none left after a stop, a close or a mode switch,
// the reference's and the result's clips as long.
//
// Needs the dev server (`npm run dev`, port 1420) and the engine (port
// 8756) running, and media that isn't in the repository:
//   BOBINE_TEST_FILE      a video with two audio tracks, analyzable (default:
//                         testfile.mkv at the repository's root)
//   BOBINE_TEST_FILE_NEG  one whose second track is early on the first
//                         (a negative offset); its scenario is skipped without
// Usage: npm run test:playback [-- "name filter"]
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const A = process.env.BOBINE_TEST_FILE ?? fileURLToPath(new URL("../../testfile.mkv", import.meta.url)).replaceAll("\\", "/");
const B = process.env.BOBINE_TEST_FILE_NEG ?? null;
const BASE = process.env.BOBINE_DEV_URL ?? "http://localhost:1420";
if (!existsSync(A)) {
  console.error(`No test media at ${A}: set BOBINE_TEST_FILE.`);
  process.exit(2);
}
const only = process.argv[2];
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];

const instrument = () => {
  const sources = new Set();
  window.__audio = { sources, max: 0, contexts: 0 };
  const active = () => [...sources].filter((s) => !s.__ended && s.context.state === "running").length;
  window.__activeSources = active;
  const S = AudioBufferSourceNode.prototype;
  const start = S.start;
  const stop = S.stop;
  // Stopped at once (stop() with no time): silent from now, whatever the
  // "ended" event's own timing.
  S.stop = function (...args) {
    if (args.length === 0 || args[0] === undefined || args[0] <= this.context.currentTime) this.__ended = true;
    return stop.apply(this, args);
  };
  S.start = function (...args) {
    sources.add(this);
    (window.__audio.durations ??= []).push(Math.round((this.buffer?.duration ?? 0) * 100) / 100);
    this.addEventListener("ended", () => (this.__ended = true));
    const r = start.apply(this, args);
    window.__audio.max = Math.max(window.__audio.max, active());
    return r;
  };
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...a) {
      super(...a);
      window.__audio.contexts++;
    }
  };
};

async function scenario(name, fn, { url = `batchFiles=${encodeURIComponent(A)}`, needs = [] } = {}) {
  if (only && !name.includes(only)) return;
  if (needs.some((file) => !file)) {
    console.log(`skip ${name} (no media for it)`);
    return;
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "fr-FR" });
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  const problems = [];
  page.on("response", async (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().split("?")[0].split("/").pop()} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  });
  page.on("pageerror", (e) => problems.push("pageerror " + e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && problems.push("console " + m.text().slice(0, 200)));
  const t = {
    page,
    problems,
    check: (c, m) => {
      if (!c) problems.push("FAILED " + m);
    },
    active: () => page.evaluate(() => window.__activeSources()),
    maxActive: () => page.evaluate(() => window.__audio.max),
    async analyzed(scope = ".detail-body") {
      // The detail's Analyser (the gradient one with one file; the footer's
      // holds the gradient with several).
      const analyze = page.locator(".detail-header button", { hasText: /^Analyser$/ });
      await analyze.waitFor({ timeout: 120000 });
      await page.waitForFunction(() => [...document.querySelectorAll(".detail-header button")].some((b) => b.textContent === "Analyser" && !b.disabled), null, { timeout: 120000 });
      await analyze.click();
      await page.getByRole("button", { name: /Modifier les segments/ }).waitFor({ timeout: 300000 });
      await page.locator(`${scope} .waveform-svg`).first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(300);
    },
    play: (scope) => page.locator(`${scope} .preview-play`).click(),
    label: (scope) => page.locator(`${scope} .preview-play`).textContent(),
    async playing(scope, timeout = 30000) {
      await page.waitForFunction((s) => document.querySelector(`${s} .preview-play`)?.textContent === "Arrêter", scope, { timeout });
    },
    async stopped(scope, timeout = 10000) {
      await page.waitForFunction((s) => document.querySelector(`${s} .preview-play`)?.textContent === "Écouter", scope, { timeout });
    },
    cursor: (scope) =>
      page.evaluate((s) => {
        const el = [...document.querySelectorAll(`${s} .waveform-cursor`)].find((e) => e.getClientRects().length);
        return el ? el.getBoundingClientRect().left : null;
      }, scope),
    position: (scope) => page.locator(`${scope} .preview-controls input[type=number]`).inputValue(),
    setPosition: (scope, v) => page.locator(`${scope} .preview-controls input[type=number]`).fill(String(v)),
    waveformBox: (scope, i = 1) => page.locator(`${scope} .waveform-svg`).nth(i).boundingBox(),
    async openEditor() {
      await page.getByRole("button", { name: /Modifier les segments/ }).click();
      await page.locator(".editor-preview .waveform-svg").first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(300);
    },
    cancelEditor: () => page.locator(".editor-panel").getByRole("button", { name: "Annuler" }).click(),
    // The clips of the last start, in play order: reference, the track as
    // it is, the result. The reference and the result must last as long
    // (the track as it is may end sooner: it can be shorter).
    lastDurations: () => page.evaluate(() => (window.__audio.durations ?? []).slice(-3)),
  };
  try {
    await page.goto(`${BASE}/?${url}`);
    await fn(t);
  } catch (e) {
    problems.push("EXCEPTION " + e.message.split("\n")[0]);
  }
  results.push([name, problems]);
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
  await ctx.close();
}

const D = ".detail-body";
const E = ".editor-preview";

await scenario("play, cursor moves, stop silences", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  const c0 = await t.cursor(D);
  await t.page.waitForTimeout(1500);
  const c1 = await t.cursor(D);
  t.check(c1 > c0, `cursor did not move (${c0} -> ${c1})`);
  t.check((await t.active()) === 3, `active sources while playing: ${await t.active()}`);
  await t.play(D);
  await t.stopped(D);
  await t.page.waitForTimeout(200);
  t.check((await t.active()) === 0, `sources after stop: ${await t.active()}`);
});

await scenario("Space toggles, rapid presses never stack", async (t) => {
  await t.analyzed();
  await t.page.locator("body").click({ position: { x: 3, y: 895 } });
  for (let i = 0; i < 7; i++) {
    await t.page.keyboard.press(" ");
    await t.page.waitForTimeout(60);
  }
  await t.page.waitForTimeout(2500);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
  const playing = (await t.label(D)) === "Arrêter";
  t.check(!playing || (await t.active()) === 3, `label Arrêter but ${await t.active()} sources`);
  t.check(playing || (await t.active()) === 0, `label Écouter but ${await t.active()} sources`);
});

await scenario("clicking Écouter repeatedly while it loads", async (t) => {
  await t.analyzed();
  for (let i = 0; i < 5; i++) await t.page.locator(`${D} .preview-play`).click({ force: true, timeout: 1000 }).catch(() => {});
  await t.page.waitForTimeout(3000);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
});

await scenario("seek by click while playing (inside and outside the loaded clip)", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  const box = await t.waveformBox(D);
  await t.page.mouse.click(box.x + box.width * 0.003, box.y + box.height / 2);
  await t.page.waitForTimeout(600);
  t.check((await t.active()) === 3, `after an inside seek: ${await t.active()} sources`);
  await t.page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await t.page.waitForTimeout(3000);
  t.check((await t.label(D)) === "Arrêter", "stopped after a far seek");
  t.check((await t.active()) === 3, `after a far seek: ${await t.active()} sources`);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
  const pos = Number(await t.position(D));
  t.check(pos > 500, `position after far seek ${pos}`);
});

await scenario("scrub while playing, position field follows the drag", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  const box = await t.waveformBox(D);
  const y = box.y + box.height / 2;
  await t.page.mouse.move(box.x + box.width * 0.2, y);
  await t.page.mouse.down();
  await t.page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
  const during = Number(await t.position(D));
  await t.page.mouse.move(box.x + box.width * 0.55, y, { steps: 2 });
  await t.page.mouse.up();
  await t.page.waitForTimeout(3000);
  t.check(during > 600 && during < 900, `position field during the drag: ${during}`);
  t.check((await t.label(D)) === "Arrêter", "not playing after the scrub");
  t.check((await t.active()) === 3, `after scrub: ${await t.active()} sources`);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
});

await scenario("play near the end of the track", async (t) => {
  await t.analyzed();
  await t.setPosition(D, 1555);
  await t.play(D);
  await t.playing(D);
  await t.page.waitForTimeout(8000);
  t.check((await t.label(D)) === "Écouter", "still Arrêter after the clip ended");
  t.check((await t.active()) === 0, `sources after the end: ${await t.active()}`);
});

for (const v of ["99999", "-50", "", "1560.9"]) {
  await scenario(`position typed out of range: "${v}"`, async (t) => {
    await t.analyzed();
    await t.setPosition(D, v);
    await t.play(D);
    await t.page.waitForTimeout(4000);
    const errors = await t.page.locator(`${D} .preview .error`).allTextContents();
    t.check(errors.length === 0, `error shown: ${errors}`);
  });
}

await scenario("mute toggles and zoom/pan while playing", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  for (const l of await t.page.locator(`${D} .preview-hear input`).all()) {
    await l.click();
    await t.page.waitForTimeout(100);
    await l.click();
  }
  await t.page.locator(`${D} .zoom-button`).first().click();
  await t.page.locator(`${D} .zoom-button`).first().click();
  const box = await t.waveformBox(D);
  await t.page.mouse.move(box.x + box.width * 0.6, box.y + 20);
  await t.page.mouse.down({ button: "middle" });
  await t.page.mouse.move(box.x + box.width * 0.4, box.y + 20, { steps: 4 });
  await t.page.mouse.up({ button: "middle" });
  await t.page.waitForTimeout(800);
  t.check((await t.label(D)) === "Arrêter" && (await t.active()) === 3, `after mute/zoom/pan: ${await t.label(D)} ${await t.active()}`);
});

await scenario("the user's bug: editor playing at 300 s, Annuler, then Écouter in the detail", async (t) => {
  await t.analyzed();
  await t.openEditor();
  await t.setPosition(E, 300);
  await t.play(E);
  await t.playing(E);
  await t.page.waitForTimeout(1500);
  await t.cancelEditor();
  await t.page.waitForTimeout(400);
  t.check((await t.active()) === 0, `sources after closing the editor: ${await t.active()}`);
  const pos = await t.position(D);
  t.check(Number(pos) >= 300, `detail position after the editor: ${pos} (expected the editor's 300+)`);
  await t.play(D);
  await t.playing(D);
  t.check((await t.active()) === 3, `detail playing: ${await t.active()} sources`);
});

await scenario("detail playing, open the editor: the detail stops", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  await t.openEditor();
  await t.page.waitForTimeout(400);
  t.check((await t.active()) === 0, `sources with the editor open: ${await t.active()}`);
});

await scenario("Annuler the editor while its clip is loading (no ghost playback)", async (t) => {
  await t.analyzed();
  await t.openEditor();
  await t.play(E);
  await t.page.waitForTimeout(80);
  await t.cancelEditor();
  await t.page.waitForTimeout(4000);
  t.check((await t.active()) === 0, `ghost sources: ${await t.active()}`);
});

await scenario("edit a segment while the editor plays", async (t) => {
  await t.analyzed();
  await t.openEditor();
  await t.play(E);
  await t.playing(E);
  const cell = t.page.locator(".editor-table tbody tr").nth(0).locator("input").nth(2);
  await cell.fill("10");
  await cell.blur();
  await t.page.waitForTimeout(3000);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
  const n = await t.active();
  t.check(n === 3 || n === 0, `sources ${n}`);
});

await scenario("open and close the editor 8 times, playing each time", async (t) => {
  await t.analyzed();
  for (let i = 0; i < 8; i++) {
    await t.openEditor();
    await t.play(E);
    await t.playing(E);
    await t.cancelEditor();
    await t.page.waitForTimeout(300);
  }
  t.check((await t.active()) === 0, `sources after: ${await t.active()}`);
  await t.play(D);
  await t.playing(D);
  t.check((await t.active()) === 3, `detail after 8 editors: ${await t.active()}`);
});

await scenario(
  "select another file while playing",
  async (t) => {
    await t.analyzed();
    await t.play(D);
    await t.playing(D);
    await t.page.locator(".list-row-main").nth(1).click();
    await t.page.waitForTimeout(600);
    t.check((await t.active()) === 0, `sources after switching file: ${await t.active()}`);
  },
  { url: `batchFiles=${encodeURIComponent(A)}|${encodeURIComponent(B ?? "")}`, needs: [B] },
);

await scenario("switch mode while playing", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  await t.page.getByRole("tab", { name: /Paires/ }).click();
  await t.page.waitForTimeout(800);
  t.check((await t.active()) === 0, `sources still playing in the hidden mode: ${await t.active()}`);
});

await scenario("fold the list while playing", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  await t.page.locator(".fold-button:visible").click();
  await t.page.waitForTimeout(600);
  t.check((await t.label(D)) === "Arrêter" && (await t.active()) === 3, `after folding: ${await t.label(D)} ${await t.active()}`);
});

await scenario(
  "pairs: play across two files",
  async (t) => {
    await t.analyzed();
    await t.play(D);
    await t.playing(D);
    await t.page.waitForTimeout(1000);
    t.check((await t.active()) === 3, `pairs sources ${await t.active()}`);
  },
  { url: `batchRef=${encodeURIComponent(A)}&batchCand=${encodeURIComponent(A)}` },
);


await scenario("reference and result clips last as long (positive offset)", async (t) => {
  await t.analyzed();
  for (const pos of [0, 700, 1555]) {
    await t.setPosition(D, pos);
    await t.play(D);
    await t.playing(D);
    const d = await t.lastDurations();
    t.check(d.length === 3 && Math.abs(d[0] - d[2]) < 0.06, `reference / as is / result lengths at ${pos}: ${d}`);
    await t.play(D);
    await t.stopped(D);
  }
});

await scenario(
  "reference and result clips last as long (negative offset: Slime, FR early)",
  async (t) => {
    await t.analyzed();
    for (const pos of [0, 300]) {
      await t.setPosition(D, pos);
      await t.play(D);
      await t.playing(D, 60000);
      const d = await t.lastDurations();
      t.check(d.length === 3 && Math.abs(d[0] - d[2]) < 0.06, `reference / as is / result lengths at ${pos}: ${d}`);
      await t.play(D);
      await t.stopped(D);
    }
  },
  { url: `batchFiles=${encodeURIComponent(B ?? "")}`, needs: [B] },
);

await scenario("a clip ends by itself after 12 s", async (t) => {
  await t.analyzed();
  await t.setPosition(D, 100);
  await t.play(D);
  await t.playing(D);
  await t.page.waitForTimeout(13500);
  t.check((await t.label(D)) === "Écouter", "still Arrêter after 13.5 s");
  t.check((await t.active()) === 0, `sources after the clip: ${await t.active()}`);
  await t.play(D);
  await t.playing(D);
  t.check((await t.active()) === 3, `plays again after the end: ${await t.active()}`);
});

await scenario("two far seeks in a row while loading: only the last plays", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  const box = await t.waveformBox(D);
  await t.page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
  await t.page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await t.page.waitForTimeout(4000);
  t.check((await t.maxActive()) <= 3, `max simultaneous sources ${await t.maxActive()}`);
  const pos = Number(await t.position(D));
  t.check(pos > 1150, `plays from the last seek (position ${pos})`);
  t.check((await t.active()) === 3, `sources ${await t.active()}`);
});

await scenario("Space typed in the position field doesn't play", async (t) => {
  await t.analyzed();
  await t.page.locator(`${D} .preview-controls input[type=number]`).click();
  await t.page.keyboard.press(" ");
  await t.page.waitForTimeout(1500);
  t.check((await t.label(D)) === "Écouter" && (await t.active()) === 0, `played from the field: ${await t.label(D)}`);
});

await scenario("a click sets the position, Écouter starts there", async (t) => {
  await t.analyzed();
  const box = await t.waveformBox(D);
  await t.page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await t.page.waitForTimeout(300);
  const pos = Number(await t.position(D));
  await t.play(D);
  await t.playing(D);
  const at = await t.page.evaluate(() => {
    const s = [...window.__audio.sources].at(-1);
    return s ? 1 : 0;
  });
  t.check(pos > 700 && pos < 860, `position after the click ${pos}`);
  t.check(at === 1 && (await t.active()) === 3, "not playing");
});

await scenario("resize the window while playing", async (t) => {
  await t.analyzed();
  await t.play(D);
  await t.playing(D);
  for (const [w, h] of [[1100, 700], [1024, 640], [1600, 950], [1440, 900]]) {
    await t.page.setViewportSize({ width: w, height: h });
    await t.page.waitForTimeout(250);
  }
  t.check((await t.label(D)) === "Arrêter" && (await t.active()) === 3, `after resizing: ${await t.label(D)} ${await t.active()}`);
});

await scenario(
  "pairs: the editor plays and closes cleanly",
  async (t) => {
    await t.analyzed();
    await t.openEditor();
    await t.setPosition(E, 200);
    await t.play(E);
    await t.playing(E);
    t.check((await t.active()) === 3, `pairs editor sources ${await t.active()}`);
    await t.cancelEditor();
    await t.page.waitForTimeout(400);
    t.check((await t.active()) === 0, `after closing ${await t.active()}`);
    t.check(Number(await t.position(D)) >= 200, `position kept: ${await t.position(D)}`);
  },
  { url: `batchRef=${encodeURIComponent(A)}&batchCand=${encodeURIComponent(A)}` },
);

await browser.close();
const failed = results.filter(([, p]) => p.length);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
