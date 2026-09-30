// ISO 639-2 codes, as Matroska tags tracks with them.
const LANGUAGE_NAMES: Record<string, string> = {
  fre: "Français",
  eng: "Anglais",
  jpn: "Japonais",
  ger: "Allemand",
  spa: "Espagnol",
  ita: "Italien",
  por: "Portugais",
  dut: "Néerlandais",
  rus: "Russe",
  pol: "Polonais",
  kor: "Coréen",
  chi: "Chinois",
  ara: "Arabe",
  swe: "Suédois",
  nor: "Norvégien",
  dan: "Danois",
  fin: "Finnois",
  tur: "Turc",
  heb: "Hébreu",
  hin: "Hindi",
  tha: "Thaï",
  vie: "Vietnamien",
};

/** "Français (fre)", or the bare code for one not in the list above. */
export function languageLabel(code: string | null): string {
  if (!code) return "sans langue";
  const name = LANGUAGE_NAMES[code];
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
  const codes = [...new Set(onlyExtra ? found : [...found, ...Object.keys(LANGUAGE_NAMES)])];
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
