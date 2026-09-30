import { useState } from "react";
import { InfoTip } from "./InfoTip";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";
import { GearIcon } from "./icons";
import { Dialog, DialogHeader } from "./Dialog";
import { useLanguageChoice, useT, type LanguageChoice } from "./i18n";

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** The ⚙ button, top right, and the Options dialog it opens. */
export function OptionsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-button" title={t.options.title} aria-label={t.options.title} onClick={() => setOpen(true)}>
        <GearIcon />
      </button>
      {open && <OptionsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function OptionsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [language, setLanguage] = useLanguageChoice();

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    applyTheme(choice);
  }

  return (
    <Dialog onClose={onClose} closeOnBackdrop className="options-panel" labelledBy="options-title">
      <DialogHeader id="options-title" title={t.options.title} onClose={onClose} />
      <div className="options-row">
        <label htmlFor="options-theme">{t.options.theme}</label>
        <select id="options-theme" value={theme} onChange={(e) => chooseTheme(e.target.value as ThemeChoice)}>
          {THEMES.map((value) => (
            <option key={value} value={value}>
              {t.options.themes[value]}
            </option>
          ))}
        </select>
        <InfoTip>{t.options.themeHint}</InfoTip>
      </div>
      <div className="options-row">
        <label htmlFor="options-language">{t.options.language}</label>
        {/* Each language by its own name, whatever the current one. */}
        <select id="options-language" value={language} onChange={(e) => setLanguage(e.target.value as LanguageChoice)}>
          <option value="system">{t.options.systemLanguage}</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
        <InfoTip>{t.options.languageHint}</InfoTip>
      </div>
    </Dialog>
  );
}
