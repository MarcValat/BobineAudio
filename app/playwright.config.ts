// The end-to-end tests (npm run test:e2e): the app in Chromium, driven like
// a user, against the real engine and synthetic media (e2e/make_media.py,
// made before the tests by e2e/global-setup.ts). Vite and the engine are
// started for the run and stopped after -- or, already running (`tauri dev`
// or `npm run dev`), used as they are.
//
// Not covered here: the real Tauri window (title bar, native dialogs,
// WebView2 / WebKitGTK specifics) and the sound itself (only what plays,
// when, and for how long).
import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One at a time: the tests share one engine (its analyses would slow each
  // other down) and one media folder.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
    // Screenshots compared to the ones recorded on this system (fonts and
    // rendering differ from one to another): e2e/__screenshots__/<platform>.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" },
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}",
  // A screenshot not recorded yet is recorded, the test passing.
  updateSnapshots: "missing",
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  outputDir: "e2e/results",
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "fr-FR",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx vite --port 1420 --strictPort",
      url: "http://localhost:1420",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "uv run --project ../engine syncaudio serve --port 8756",
      url: "http://127.0.0.1:8756/health",
      reuseExistingServer: true,
      timeout: 120_000,
      // Its request log stays out of the tests' output.
      stdout: "ignore",
      stderr: "ignore",
      // Its own analysis cache, not the app's.
      env: { SYNCAUDIO_CACHE_DIR: join(tmpdir(), "bobine-e2e-cache") },
    },
  ],
});
