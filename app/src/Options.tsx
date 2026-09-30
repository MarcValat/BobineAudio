import { useState } from "react";
import { useEscape } from "./batchShared";
import { InfoTip } from "./InfoTip";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";
import { GearIcon } from "./icons";

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
        <GearIcon />
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
