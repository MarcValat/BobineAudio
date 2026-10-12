import { Select } from "./Dropdown";
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

// How releases usually tag a language in a track's name ("FR Opus 2.0",
// "JP AAC 2.0"): mostly the country's two letters, not ISO 639-1's.
const SHORT_LANGUAGES: Record<string, string> = {
  fre: "FR",
  fra: "FR",
  eng: "EN",
  jpn: "JP",
  ger: "DE",
  deu: "DE",
  spa: "ES",
  ita: "IT",
  por: "PT",
  dut: "NL",
  nld: "NL",
  rus: "RU",
  pol: "PL",
  kor: "KR",
  chi: "CN",
  zho: "CN",
  ara: "AR",
  swe: "SE",
  nor: "NO",
  dan: "DK",
  fin: "FI",
  tur: "TR",
  heb: "IL",
  hin: "IN",
  tha: "TH",
  vie: "VN",
};

/** "FR" for "fre": a language as a track's name shows it (the code in
 * capitals for one not among the usual ones). */
export function shortLanguage(code: string | null): string | null {
  return code ? (SHORT_LANGUAGES[code] ?? code.toUpperCase()) : null;
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
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  extra?: (string | null)[];
  onlyExtra?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  /** Its name for a screen reader, when no <label> wraps it. */
  label?: string;
}) {
  const found = extra.filter((c): c is string => !!c);
  const codes = [...new Set(onlyExtra ? found : [...found, ...Object.keys(languageNames())])];
  return (
    <Select
      label={label ?? ""}
      value={value}
      options={[
        ...(emptyLabel !== undefined ? [{ value: "", label: emptyLabel }] : []),
        ...codes.map((code) => ({ value: code, label: languageLabel(code) })),
      ]}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
