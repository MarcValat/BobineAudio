// Every screen audited (see audit.ts) at the smallest window and a usual
// one, in both themes and both languages: what's found is listed by screen.
import { inspect } from "./audit";
import { expect, test, type App } from "./fixtures";
import { E01, E01_VF, E02, E02_VF, E03, multiUrl, pairsUrl } from "./media";

/** Found, and known: awaiting a decision, not to fail the run meanwhile. */
const KNOWN: RegExp[] = [];

const SIZES = [
  [1024, 640],
  [1440, 900],
] as const;

for (const [width, height] of SIZES)
  for (const theme of ["dark", "light"] as const)
    for (const language of ["fr", "en"] as const) {
      test(`${width}x${height} ${theme} ${language}`, async ({ app }) => {
        test.setTimeout(300_000);
        const { page } = app;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript(
          ([language, theme]) => {
            localStorage.setItem("syncaudio.language", language);
            localStorage.setItem("syncaudio.theme", theme);
          },
          [language, theme],
        );
        const fr = language === "fr";
        const found: string[] = [];
        /** `screen` reached by `reach`, the pointer out of the way, audited. */
        const audit = async (screen: string, reach: () => Promise<unknown>) => {
          await reach();
          await page.mouse.move(width - 1, height - 1);
          await page.waitForTimeout(450); // transitions done
          for (const [kind, what] of await inspect(page)) {
            const finding = `${screen}: ${kind} -- ${what}`;
            if (!KNOWN.some((known) => known.test(finding))) found.push(finding);
          }
        };
        const escape = () => page.keyboard.press("Escape").then(() => page.waitForTimeout(400));

        await audit("empty multitrack", () => page.goto("/?windowControls=1"));
        await audit("empty pairs", () => page.getByRole("tab", { name: fr ? "Paires de fichiers" : "File pairs" }).click());

        await audit("multitrack files", async () => {
          await page.goto(`${multiUrl(E01, E02, E03)}&windowControls=1`);
          await expect(app.footerPrimary()).toBeEnabled({ timeout: 120_000 });
        });
        await audit("track picker open", () => page.locator(".batch-config .dropdown-button").first().click());
        await escape();
        await audit("analyzed", async () => {
          await analyzeAll(app);
          await app.rows().first().locator(".list-row-main").click();
        });
        await audit("row hovered", () => app.rows().nth(1).hover());
        await audit("Tout retirer's question", () =>
          page
            .getByRole("button", { name: fr ? "Tout retirer" : "Remove all" })
            .first()
            .click(),
        );
        await escape();
        await audit("log", () =>
          page
            .getByRole("button", { name: fr ? /Journal/ : /Log/ })
            .first()
            .click(),
        );
        await escape();
        await audit("subtitles dialog", async () => {
          // A narrow window shows the detail in tabs: the tracks are on the first.
          const segmentsTab = page.getByRole("tab", { name: "Segments" });
          if (await segmentsTab.isVisible()) await segmentsTab.click();
          await page
            .getByRole("button", { name: fr ? "Changer" : "Change" })
            .first()
            .click();
        });
        await escape();
        await audit("export options", () => page.getByRole("button", { name: fr ? "Modifier…" : "Change…" }).click());
        await escape();
        await audit("list folded", () => page.locator(".fold-button:visible").click());
        await page.locator(".fold-button:visible").click();
        await audit("editor", async () => {
          await page.getByRole("button", { name: fr ? "Modifier les segments" : "Edit segments" }).click();
          await page.locator(".editor-chart").waitFor();
          await page.waitForTimeout(800);
        });
        await escape();
        await audit("settings", () => page.getByRole("button", { name: fr ? "Paramètres" : "Settings" }).click());
        await escape();

        await audit("pairs", async () => {
          await page.goto(`${pairsUrl([E01, E02], [E01_VF, E02_VF])}&windowControls=1`);
          await expect(app.footerPrimary()).toBeEnabled({ timeout: 120_000 });
        });
        await audit("pairs analyzed", () => analyzeAll(app));
        await audit("all tracks", () => page.getByRole("button", { name: fr ? "Toutes les pistes" : "All tracks" }).click());
        await escape();
        await audit("pairs folded", () => page.locator(".fold-button:visible").click());

        expect(found).toEqual([]);
      });
    }

/** Every row analyzed, in either language. */
async function analyzeAll(app: App) {
  await expect(app.rows().filter({ hasText: /Lecture…|Reading…/ })).toHaveCount(0, { timeout: 120_000 });
  await app.footerPrimary().click();
  await expect(
    app
      .rows()
      .locator(".list-badge")
      .filter({ hasText: /^(Analysée?|Analyzed)( ·|$)/ }),
  ).toHaveCount(await app.rows().count(), {
    timeout: 300_000,
  });
}
