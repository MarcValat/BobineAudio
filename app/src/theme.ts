import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSetting, saveSetting } from "./util";

/** "system" follows the OS; the others force it. */
export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "syncaudio.theme";

export function loadTheme(): ThemeChoice {
  const saved = loadSetting(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** Applies `choice` to the page (App.css's colors follow `data-theme`) and
 * to the window's title bar, and remembers it for the next session. Once
 * the app shows, the page cross-fades into it (crossFade). */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  crossFade(() => {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
  });
  saveSetting(THEME_KEY, choice === "system" ? null : choice);
  // Outside Tauri (the dev server in a plain browser) there's no window to theme.
  try {
    getCurrentWindow()
      .setTheme(choice === "system" ? null : choice)
      .catch(() => {});
  } catch {
    // not running in Tauri
  }
}

/** Runs `change` as one cross-fade of the whole window (the View Transitions
 * API, App.css's ::view-transition rules): every text, panel, icon and
 * waveform fades at the same pace. Fading each element's own colors left
 * out the ones that inherit theirs (a drop zone's hint stayed sharp while
 * its button faded). Instant where there's nothing to fade from yet (the
 * first paint), where the engine lacks the API (older WebKitGTK), and with
 * reduced motion. The controls' own hover transitions are paused meanwhile,
 * or they'd fade a second time inside the new picture. */
function crossFade(change: () => void): void {
  const root = document.documentElement;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!document.body || reduced || typeof document.startViewTransition !== "function") {
    change();
    return;
  }
  root.classList.add("theme-switching");
  const transition = document.startViewTransition(change);
  transition.finished.finally(() => root.classList.remove("theme-switching"));
}
