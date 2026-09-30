import { useState } from "react";
import { useEscape } from "./batchShared";
import { InfoTip } from "./InfoTip";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Système" },
  { value: "light", label: "Clair" },
  { value: "dark", label: "Sombre" },
];

/** The ⚙ button, top right, and the Options dialog it opens. */
export function OptionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-button" title="Options" aria-label="Options" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && <OptionsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function OptionsDialog({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  useEscape(onClose);

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    applyTheme(choice);
  }

  return (
    <div className="options-overlay" role="dialog" aria-modal="true" aria-labelledby="options-title" onClick={onClose}>
      <div className="options-panel panel" onClick={(e) => e.stopPropagation()}>
        <div className="options-header">
          <h2 id="options-title">Options</h2>
          <button className="small-button" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="options-row">
          <label htmlFor="options-theme">Thème</label>
          <select id="options-theme" value={theme} onChange={(e) => chooseTheme(e.target.value as ThemeChoice)}>
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <InfoTip>« Système » suit le thème clair ou sombre de Windows.</InfoTip>
        </div>
      </div>
    </div>
  );
}
