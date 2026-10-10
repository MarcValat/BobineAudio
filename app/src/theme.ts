import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSetting, saveSetting } from "./util";

/** "system" follows Windows; the others force it. */
export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "syncaudio.theme";

export function loadTheme(): ThemeChoice {
  const saved = loadSetting(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** Applies `choice` to the page (App.css's colors follow `data-theme`) and
 * to the window's title bar, and remembers it for the next session. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  withoutTransitions(root);
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
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

/** Switches the whole page at once: the controls' color transitions (meant
 * for hover) would otherwise fade them into the new theme while everything
 * else flips. Restored two frames later, once the new colors are painted. */
function withoutTransitions(root: HTMLElement): void {
  root.classList.add("theme-switching");
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

// "Système" follows the OS live: the same instant switch when it changes.
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.hasAttribute("data-theme")) withoutTransitions(document.documentElement);
  });
} catch {
  // no matchMedia: nothing to follow
}
