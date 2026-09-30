import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n";
import { applyTheme, loadTheme } from "./theme";
import { engineReady } from "./engine";

// Before the first render, so a forced theme never flashes the other one.
applyTheme(loadTheme());

// Wait for the engine from the start: the UI is usable meanwhile, its
// requests go through once it answers (see engine.ts).
engineReady().catch(() => {});

// The WebView's default right-click menu (Reload/Inspect/Save as...) has
// nothing useful for this app's users -- keep it in `npm run tauri dev`
// (import.meta.env.DEV is Vite's own dev-vs-build flag) since Inspect is
// genuinely handy while developing, but drop it from the compiled app.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
