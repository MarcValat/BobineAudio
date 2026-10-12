// The main screens compared to screenshots recorded earlier on this system
// (e2e/__screenshots__/<platform>, not in git: fonts and rendering differ
// between systems). The first run records them; after a wanted change,
// `npm run test:e2e -- e2e/visual.spec.ts --update-snapshots` records them
// again.
import { expect, test } from "./fixtures";
import { E01, E01_VF, E02, multiUrl, pairsUrl } from "./media";

for (const theme of ["dark", "light"] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ app }) => {
      await app.page.emulateMedia({ colorScheme: theme });
    });

    test("empty workspace", async ({ app }) => {
      await app.page.goto("/?windowControls=1");
      await expect(app.page).toHaveScreenshot(`empty-${theme}.png`);
    });

    test("multitrack, analyzed", async ({ app }) => {
      await app.page.goto(`${multiUrl(E01, E02)}&windowControls=1`);
      await app.analyze();
      await app.page.mouse.move(1, 1);
      await expect(app.page).toHaveScreenshot(`multi-${theme}.png`);
      await app.openEditor();
      await expect(app.page).toHaveScreenshot(`editor-${theme}.png`);
    });

    test("pairs, analyzed", async ({ app }) => {
      await app.page.goto(`${pairsUrl([E01], [E01_VF])}&windowControls=1`);
      await app.analyze();
      await app.page.mouse.move(1, 1);
      await expect(app.page).toHaveScreenshot(`pairs-${theme}.png`);
    });

    test("settings", async ({ app }) => {
      await app.page.goto("/?windowControls=1");
      await app.page.getByRole("button", { name: "Paramètres" }).click();
      await app.page.waitForTimeout(500);
      // The version and the cache's size change from one run to the next.
      await expect(app.page).toHaveScreenshot(`settings-${theme}.png`, {
        mask: [app.page.getByText(/Version actuelle/), app.page.locator(".options-cache")],
      });
    });
  });
}
