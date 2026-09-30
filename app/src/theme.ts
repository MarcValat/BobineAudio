import { getCurrentWindow } from "@tauri-apps/api/window";

/** "system" follows Windows; the others force it. */
export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "syncaudio.theme";

export function loadTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Applies `choice` to the page (App.css's colors follow `data-theme`) and
 * to the window's title bar, and remembers it for the next session. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // not remembered this time
  }
  // Outside Tauri (the dev server in a plain browser) there's no window to theme.
  try {
    getCurrentWindow()
      .setTheme(choice === "system" ? null : choice)
      .catch(() => {});
  } catch {
    // not running in Tauri
  }
}
