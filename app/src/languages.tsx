import { t } from "./i18n";

// The usual languages, by ISO 639-2 code (as Matroska tags tracks), named
// in the UI's language.
const languageNames = (): Record<string, string> => t().languages.names;

/** "French (fre)", or the bare code for one not among the usual ones. */
export function languageLabel(code: string | null): string {
  if (!code) return t().languages.none;
  const name = languageNames()[code];
  return name ? `${name} (${code})` : code;
}

/** A language picker: the ones the files at hand use (`extra`), plus the
 * usual ones unless `onlyExtra` -- to pick among what's there, not to tag
 * a track with a new one. `emptyLabel` names the "" choice (keep the
 * track's own, pick none...). */
export function LanguageSelect({
  value,
  onChange,
  extra = [],
  onlyExtra = false,
  emptyLabel,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  extra?: (string | null)[];
  onlyExtra?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const found = extra.filter((c): c is string => !!c);
  const codes = [...new Set(onlyExtra ? found : [...found, ...Object.keys(languageNames())])];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {codes.map((code) => (
        <option key={code} value={code}>
          {languageLabel(code)}
        </option>
      ))}
    </select>
  );
}
