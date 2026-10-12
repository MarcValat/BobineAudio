import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { InfoTip } from "./InfoTip";
import { PillSwitch } from "./PillSwitch";
import { applyTheme, loadTheme, type ThemeChoice } from "./theme";
import "./Options.css";
import { CloseIcon, GearIcon } from "./icons";
import { Dialog } from "./Dialog";
import { Select } from "./Dropdown";
import { useLanguageChoice, useT, type LanguageChoice } from "./i18n";
import { clearCache, getCacheSize } from "./api";
import { saveCheckUpdates, saveSubtitleDefault, useCheckUpdates, useSubtitleDefault } from "./settings";
import { SUBTITLE_MODES } from "./subtitles";
import { UI_SCALES, loadUiScale, saveUiScale, useEffectiveUiScale, type UiScale } from "./uiScale";
import { errorMessage } from "./util";

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** The engine's cache limit (analysis_cache.py), shown as how full it is. */
const CACHE_LIMIT_MB = 512;

/** The ⚙ button, top right, and the settings drawer it opens (shown
 * pressed while it's open). */
export function OptionsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  /** The drawer slides out (CLOSE_MS, see Dialog.css), then goes. */
  function close() {
    if (closing) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setOpen(false);
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
  }
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <>
      <button
        className={`icon-button${open && !closing ? " icon-button-on" : ""}`}
        title={t.options.title}
        aria-label={t.options.title}
        aria-expanded={open && !closing}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <GearIcon />
      </button>
      {open && <OptionsDrawer closing={closing} onClose={close} />}
    </>
  );
}

/** How long the drawer takes to slide out (Dialog.css's dialog-slide-out). */
const CLOSE_MS = 220;

/** One setting: its name with what it does in a "?" tip (as everywhere in
 * the suite), its control, and `note`, a fact worth seeing at once. */
function Setting({ label, hint, note, children }: { label: ReactNode; hint?: ReactNode; note?: ReactNode; children?: ReactNode }) {
  const name = <span className="setting-name">{label}</span>;
  return (
    <div className="setting">
      <span className="setting-title">
        {name}
        {hint && <InfoTip>{hint}</InfoTip>}
      </span>
      {children}
      {note && <p className="setting-hint">{note}</p>}
    </div>
  );
}

function OptionsDrawer({ closing, onClose }: { closing: boolean; onClose: () => void }) {
  const t = useT();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [language, setLanguage] = useLanguageChoice();
  const subtitleDefault = useSubtitleDefault();
  const checkUpdates = useCheckUpdates();
  const [uiScale, setUiScale] = useState<UiScale>(loadUiScale);
  const effectiveScale = useEffectiveUiScale();
  const version = useAppVersion();

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    applyTheme(choice);
  }

  return (
    <Dialog onClose={onClose} closeOnBackdrop side closing={closing} className="options-drawer" labelledBy="options-title">
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

      <Setting label={t.options.language} hint={t.options.languageHint}>
        {/* Each language by its own name, whatever the current one. */}
        <Select
          label={t.options.language}
          value={language}
          options={[
            { value: "system", label: t.options.systemLanguage },
            { value: "fr", label: "Français" },
            { value: "en", label: "English" },
          ]}
          onChange={(choice: LanguageChoice) => setLanguage(choice)}
        />
      </Setting>

      <Setting
        label={t.options.uiScale}
        hint={t.options.uiScaleHint}
        note={effectiveScale < uiScale && t.options.uiScaleLimited(effectiveScale)}
      >
        <PillSwitch
          className="pill-switch-wide"
          label={t.options.uiScale}
          options={UI_SCALES.map((value) => [value, `${value} %`] as const)}
          value={uiScale}
          onChange={(choice) => {
            setUiScale(choice);
            saveUiScale(choice);
          }}
        />
      </Setting>

      <Setting label={t.options.subtitles} hint={t.options.subtitlesHint}>
        <Select
          label={t.options.subtitles}
          value={subtitleDefault}
          options={SUBTITLE_MODES.map((mode) => ({ value: mode, label: t.subtitles.modes[mode] }))}
          onChange={saveSubtitleDefault}
        />
      </Setting>

      <Setting label={t.options.updates} hint={t.options.updatesHint} note={version && t.options.version(version)}>
        <label className="setting-switch-row">
          <span>{t.options.checkUpdates}</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={checkUpdates}
            onChange={(e) => saveCheckUpdates(e.target.checked)}
          />
        </label>
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
