import { useEffect, useState } from "react";
import { InfoTip } from "./InfoTip";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";
import { GearIcon } from "./icons";
import { Dialog, DialogHeader } from "./Dialog";
import { useLanguageChoice, useT, type LanguageChoice } from "./i18n";
import { clearCache, getCacheSize } from "./api";
import { saveCheckUpdates, saveSubtitleDefault, useCheckUpdates, useSubtitleDefault } from "./settings";
import { SUBTITLE_MODES, type SubtitleMode } from "./subtitles";
import { errorMessage } from "./util";

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
  const subtitleDefault = useSubtitleDefault();
  const checkUpdates = useCheckUpdates();

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    applyTheme(choice);
  }

  return (
    <Dialog onClose={onClose} closeOnBackdrop className="options-panel" labelledBy="options-title">
      <DialogHeader id="options-title" title={t.options.title} onClose={onClose} />
      {/* One setting per row: its name, then its control and explanation. */}
      <div className="options-grid">
        <label htmlFor="options-theme">{t.options.theme}</label>
        <span className="options-control">
          <select id="options-theme" value={theme} onChange={(e) => chooseTheme(e.target.value as ThemeChoice)}>
            {THEMES.map((value) => (
              <option key={value} value={value}>
                {t.options.themes[value]}
              </option>
            ))}
          </select>
          <InfoTip>{t.options.themeHint}</InfoTip>
        </span>

        <label htmlFor="options-language">{t.options.language}</label>
        <span className="options-control">
          {/* Each language by its own name, whatever the current one. */}
          <select id="options-language" value={language} onChange={(e) => setLanguage(e.target.value as LanguageChoice)}>
            <option value="system">{t.options.systemLanguage}</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
          <InfoTip>{t.options.languageHint}</InfoTip>
        </span>

        <label htmlFor="options-subtitles">{t.options.subtitles}</label>
        <span className="options-control">
          <select
            id="options-subtitles"
            value={subtitleDefault}
            onChange={(e) => saveSubtitleDefault(e.target.value as SubtitleMode)}
          >
            {SUBTITLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t.subtitles.modes[mode]}
              </option>
            ))}
          </select>
          <InfoTip>{t.options.subtitlesHint}</InfoTip>
        </span>

        <span className="options-name">{t.options.updates}</span>
        <span className="options-control">
          <label className="options-check">
            <input type="checkbox" checked={checkUpdates} onChange={(e) => saveCheckUpdates(e.target.checked)} />
            {t.options.checkUpdates}
          </label>
          <InfoTip>{t.options.updatesHint}</InfoTip>
        </span>

        <span className="options-name">{t.options.cache}</span>
        <span className="options-control">
          <CacheControl />
          <InfoTip>{t.options.cacheHint}</InfoTip>
        </span>
      </div>
    </Dialog>
  );
}

/** The analysis cache's size on disk, and the button that empties it. */
function CacheControl() {
  const t = useT();
  const [bytes, setBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCacheSize()
      .then(setBytes)
      .catch(() => setBytes(null));
  }, []);

  async function clear() {
    setClearing(true);
    setError(null);
    try {
      setBytes(await clearCache());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClearing(false);
    }
  }

  const megabytes = bytes === null ? null : Math.round(bytes / (1024 * 1024));
  return (
    <span className="options-cache">
      <span className="options-cache-size">
        {bytes === null ? "…" : bytes === 0 ? t.options.cacheEmpty : t.options.cacheSize(megabytes!)}
      </span>
      <button className="small-button" onClick={clear} disabled={clearing || !bytes}>
        {clearing ? t.options.clearingCache : t.options.clearCache}
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}
