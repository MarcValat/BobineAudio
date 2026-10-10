import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { PillSwitch } from "./PillSwitch";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";
import { CloseIcon, GearIcon } from "./icons";
import { Dialog } from "./Dialog";
import { useLanguageChoice, useT, type LanguageChoice } from "./i18n";
import { clearCache, getCacheSize } from "./api";
import { saveCheckUpdates, saveSubtitleDefault, useCheckUpdates, useSubtitleDefault } from "./settings";
import { SUBTITLE_MODES, type SubtitleMode } from "./subtitles";
import { errorMessage } from "./util";

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** The engine's cache limit (analysis_cache.py), shown as how full it is. */
const CACHE_LIMIT_MB = 512;

/** The ⚙ button, top right, and the settings drawer it opens (shown
 * pressed while it's open). */
export function OptionsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`icon-button${open ? " icon-button-on" : ""}`}
        title={t.options.title}
        aria-label={t.options.title}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open && <OptionsDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

/** One setting: its name, its control, what it does in plain words. */
function Setting({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      {htmlFor ? (
        <label className="setting-name" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="setting-name">{label}</span>
      )}
      {children}
      {hint && <p className="setting-hint">{hint}</p>}
    </div>
  );
}

function OptionsDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [language, setLanguage] = useLanguageChoice();
  const subtitleDefault = useSubtitleDefault();
  const checkUpdates = useCheckUpdates();
  const version = useAppVersion();

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    applyTheme(choice);
  }

  return (
    <Dialog onClose={onClose} closeOnBackdrop side className="options-drawer" labelledBy="options-title">
      <div className="options-head">
        <h2 id="options-title">{t.options.title}</h2>
        <button className="icon-button" aria-label={t.common.close} title={t.common.close} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <Setting label={t.options.theme} hint={t.options.themeHint}>
        <PillSwitch
          className="pill-switch-wide"
          label={t.options.theme}
          options={THEMES.map((value) => [value, t.options.themes[value]] as const)}
          value={theme}
          onChange={chooseTheme}
        />
      </Setting>

      <Setting label={t.options.language} htmlFor="options-language" hint={t.options.languageHint}>
        {/* Each language by its own name, whatever the current one. */}
        <select id="options-language" value={language} onChange={(e) => setLanguage(e.target.value as LanguageChoice)}>
          <option value="system">{t.options.systemLanguage}</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </Setting>

      <Setting label={t.options.subtitles} htmlFor="options-subtitles" hint={t.options.subtitlesHint}>
        <select id="options-subtitles" value={subtitleDefault} onChange={(e) => saveSubtitleDefault(e.target.value as SubtitleMode)}>
          {SUBTITLE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t.subtitles.modes[mode]}
            </option>
          ))}
        </select>
      </Setting>

      <Setting
        label={
          <span className="setting-switch-row">
            <span>{t.options.checkUpdates}</span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              aria-label={t.options.checkUpdates}
              checked={checkUpdates}
              onChange={(e) => saveCheckUpdates(e.target.checked)}
            />
          </span>
        }
        hint={
          <>
            {t.options.updatesHint}
            {version && <> {t.options.version(version)}</>}
          </>
        }
      >
        {null}
      </Setting>

      <Setting label={t.options.cache} hint={t.options.cacheHint}>
        <CacheControl />
      </Setting>
    </Dialog>
  );
}

/** The app's version, in the installed app (none in a plain browser). */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  return version;
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
      {/* How full it is: the engine keeps it under CACHE_LIMIT_MB. */}
      <span className="options-cache-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, ((megabytes ?? 0) / CACHE_LIMIT_MB) * 100)}%` }} />
      </span>
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
