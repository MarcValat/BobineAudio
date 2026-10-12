// Listening (Écouter): what plays, when, and for how long -- never more than
// the three clips at once, none left after a stop, a close or a mode switch,
// the reference's and the result's clips as long.
import { D, E, expect, test } from "./fixtures";
import { E01, E01_VF, E02, E04, multiUrl, pairsUrl } from "./media";

test.describe("in the detail", () => {
  test.beforeEach(async ({ app }) => {
    await app.page.goto(multiUrl(E01));
    await app.analyze();
  });

  test("play, cursor moves, stop silences", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    const c0 = await app.cursor(D);
    await app.page.waitForTimeout(1500);
    expect(await app.cursor(D)).toBeGreaterThan(c0!);
    expect(await app.active()).toBe(3);
    await app.play(D);
    await app.stopped(D);
    await app.page.waitForTimeout(200);
    expect(await app.active()).toBe(0);
  });

  test("Space toggles, rapid presses never stack", async ({ app }) => {
    await app.page.locator("body").click({ position: { x: 3, y: 895 } });
    for (let i = 0; i < 7; i++) {
      await app.page.keyboard.press(" ");
      await app.page.waitForTimeout(60);
    }
    await app.page.waitForTimeout(2500);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
    const playing = /Arrêter/.test((await app.label(D)) ?? "");
    expect(await app.active()).toBe(playing ? 3 : 0);
  });

  test("clicking Écouter repeatedly while it loads", async ({ app }) => {
    for (let i = 0; i < 5; i++)
      await app.page
        .locator(`${D} .preview-play`)
        .click({ force: true, timeout: 1000 })
        .catch(() => {});
    await app.page.waitForTimeout(3000);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
  });

  test("seek by click while playing (inside and outside the loaded clip)", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.clickWaveform(D, 0.003);
    await app.page.waitForTimeout(600);
    expect(await app.active()).toBe(3);
    await app.clickWaveform(D, 0.6);
    await app.page.waitForTimeout(3000);
    await app.playing(D);
    expect(await app.active()).toBe(3);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
    expect(await app.position(D)).toBeGreaterThan(34);
  });

  test("scrub while playing, the position field follows the drag", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    const box = await app.waveformBox(D);
    const y = box.y + box.height / 2;
    await app.page.mouse.move(box.x + box.width * 0.2, y);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
    const during = await app.position(D);
    await app.page.mouse.move(box.x + box.width * 0.55, y, { steps: 2 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(3000);
    expect(during).toBeGreaterThan(25);
    expect(during).toBeLessThan(35);
    await app.playing(D);
    expect(await app.active()).toBe(3);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
  });

  test("play near the end of the track", async ({ app }) => {
    await app.setPosition(D, 57);
    await app.play(D);
    await app.playing(D);
    await app.stopped(D, 10_000);
    expect(await app.active()).toBe(0);
  });

  for (const value of ["99999", "-50", "", "60.9"]) {
    test(`position typed out of range: "${value}"`, async ({ app }) => {
      await app.setPosition(D, value);
      await app.play(D);
      await app.page.waitForTimeout(4000);
      await expect(app.page.locator(`${D} .preview .error`)).toHaveCount(0);
    });
  }

  test("mute toggles and zoom / pan while playing", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    for (const box of await app.page.locator(`${D} .preview-hear input`).all()) {
      await box.click();
      await app.page.waitForTimeout(100);
      await box.click();
    }
    await app.page.locator(`${D} .zoom-button`).first().click();
    await app.page.locator(`${D} .zoom-button`).first().click();
    const box = await app.waveformBox(D);
    await app.page.mouse.move(box.x + box.width * 0.6, box.y + 20);
    await app.page.mouse.down({ button: "middle" });
    await app.page.mouse.move(box.x + box.width * 0.4, box.y + 20, { steps: 4 });
    await app.page.mouse.up({ button: "middle" });
    await app.page.waitForTimeout(800);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("the editor playing at 20 s, Annuler, then Écouter in the detail", async ({ app }) => {
    await app.openEditor();
    await app.setPosition(E, 20);
    await app.play(E);
    await app.playing(E);
    await app.page.waitForTimeout(1500);
    await app.cancelEditor();
    await app.page.waitForTimeout(400);
    expect(await app.active()).toBe(0);
    // The detail takes on the editor's position.
    expect(await app.position(D)).toBeGreaterThanOrEqual(20);
    await app.play(D);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("the detail playing, opening the editor stops it", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.openEditor();
    await app.page.waitForTimeout(400);
    expect(await app.active()).toBe(0);
  });

  test("Annuler the editor while its clip loads: no ghost playback", async ({ app }) => {
    await app.openEditor();
    await app.play(E);
    await app.page.waitForTimeout(80);
    await app.cancelEditor();
    await app.page.waitForTimeout(4000);
    expect(await app.active()).toBe(0);
  });

  test("edit a segment while the editor plays", async ({ app }) => {
    await app.openEditor();
    await app.play(E);
    await app.playing(E);
    const cell = app.page.locator(".editor-table tbody tr").nth(0).locator("input").nth(2);
    await cell.fill("10");
    await cell.blur();
    await app.page.waitForTimeout(3000);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
    expect([0, 3]).toContain(await app.active());
  });

  test("open and close the editor 8 times, playing each time", async ({ app }) => {
    for (let i = 0; i < 8; i++) {
      await app.openEditor();
      await app.play(E);
      await app.playing(E);
      await app.cancelEditor();
      await app.page.waitForTimeout(300);
    }
    expect(await app.active()).toBe(0);
    await app.play(D);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("switch mode while playing", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.page.getByRole("tab", { name: /Paires/ }).click();
    await app.page.waitForTimeout(800);
    expect(await app.active()).toBe(0);
  });

  test("fold the list while playing", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.page.locator(".fold-button:visible").click();
    await app.page.waitForTimeout(600);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("the reference's and the result's clips last as long (positive offset)", async ({ app }) => {
    for (const at of [0, 27, 57]) {
      await app.setPosition(D, at);
      await app.play(D);
      await app.playing(D);
      const d = await app.lastDurations();
      expect(d).toHaveLength(3);
      expect(Math.abs(d[0] - d[2]), `reference / as is / result at ${at}: ${d}`).toBeLessThan(0.06);
      await app.play(D);
      await app.stopped(D);
    }
  });

  test("a clip ends by itself after 12 s, and plays again", async ({ app }) => {
    await app.setPosition(D, 10);
    await app.play(D);
    await app.playing(D);
    await app.page.waitForTimeout(13_500);
    await app.stopped(D);
    expect(await app.active()).toBe(0);
    await app.play(D);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("two far seeks in a row while loading: only the last plays", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.clickWaveform(D, 0.4);
    await app.clickWaveform(D, 0.8);
    await app.page.waitForTimeout(4000);
    expect(await app.maxActive()).toBeLessThanOrEqual(3);
    expect(await app.position(D)).toBeGreaterThan(44);
    expect(await app.active()).toBe(3);
  });

  test("Space typed in the position field doesn't play", async ({ app }) => {
    await app.page.locator(`${D} .preview-controls input[type=number]`).click();
    await app.page.keyboard.press(" ");
    await app.page.waitForTimeout(1500);
    await app.stopped(D);
    expect(await app.active()).toBe(0);
  });

  test("a click sets the position, Écouter starts there", async ({ app }) => {
    await app.clickWaveform(D, 0.5);
    await app.page.waitForTimeout(300);
    const at = await app.position(D);
    expect(at).toBeGreaterThan(27);
    expect(at).toBeLessThan(33);
    await app.play(D);
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });

  test("resize the window while playing", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    for (const [width, height] of [
      [1100, 700],
      [1024, 640],
      [1600, 950],
      [1440, 900],
    ]) {
      await app.page.setViewportSize({ width, height });
      await app.page.waitForTimeout(250);
    }
    await app.playing(D);
    expect(await app.active()).toBe(3);
  });
});

test("select another file while playing", async ({ app }) => {
  await app.page.goto(multiUrl(E01, E02));
  await app.analyze();
  await app.play(D);
  await app.playing(D);
  await app.page.locator(".list-row-main").nth(1).click();
  await app.page.waitForTimeout(600);
  expect(await app.active()).toBe(0);
});

test("the reference's and the result's clips last as long (negative offset)", async ({ app }) => {
  await app.page.goto(multiUrl(E04));
  await app.analyze();
  for (const at of [0, 20]) {
    await app.setPosition(D, at);
    await app.play(D);
    await app.playing(D, 60_000);
    const d = await app.lastDurations();
    expect(d).toHaveLength(3);
    expect(Math.abs(d[0] - d[2]), `reference / as is / result at ${at}: ${d}`).toBeLessThan(0.06);
    await app.play(D);
    await app.stopped(D);
  }
});

test.describe("pairs", () => {
  test.beforeEach(async ({ app }) => {
    await app.page.goto(pairsUrl([E01], [E01_VF]));
    await app.analyze();
  });

  test("play across two files", async ({ app }) => {
    await app.play(D);
    await app.playing(D);
    await app.page.waitForTimeout(1000);
    expect(await app.active()).toBe(3);
  });

  test("the editor plays and closes cleanly", async ({ app }) => {
    await app.openEditor();
    await app.setPosition(E, 15);
    await app.play(E);
    await app.playing(E);
    expect(await app.active()).toBe(3);
    await app.cancelEditor();
    await app.page.waitForTimeout(400);
    expect(await app.active()).toBe(0);
    expect(await app.position(D)).toBeGreaterThanOrEqual(15);
  });
});
