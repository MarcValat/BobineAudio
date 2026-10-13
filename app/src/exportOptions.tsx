import { useState } from "react";
import { createPortal } from "react-dom";
import type { TrackInfo } from "./api";
import { Dialog, DialogHeader } from "./Dialog";
import { Select } from "./Dropdown";
import { useT } from "./i18n";
import { FIELD_PROPS } from "./util";
import { languageLabel, shortLanguage } from "./languages";
import { pickFolder } from "./mediaDialog";
import { Setting } from "./Options";
import { PillSwitch } from "./PillSwitch";
import {
  EXPORT_CODECS,
  TRACK_NAMINGS,
  saveExportCodec,
  saveTrackNaming,
  useExportCodec,
  useTrackNaming,
  type ExportCodec,
} from "./settings";

/** A corrected track's export codec as releases name it, when one is asked. */
const CODEC_NAMES: Record<Exclude<ExportCodec, "auto">, string> = {
  opus: "Opus",
  aac: "AAC",
  flac: "FLAC",
  ac3: "AC3",
  eac3: "E-AC3",
};

/** "2.0", "5.1": a channel count as a track's name shows it. */
function channelLayout(channels: number | null): string | null {
  if (!channels) return null;
  return ({ 1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1" } as Record<number, string>)[channels] ?? `${channels}.0`;
}

/** "FR Opus 2.0": a corrected track named after what it is once exported --
 * its language, its export codec (the source's when "auto", as the engine
 * picks it), its channels (5.1 at most in AC3 / E-AC3, mixed down). */
function autoTrackName(track: TrackInfo, language: string | null, codec: ExportCodec): string {
  const name = codec === "auto" ? track.export_codec : CODEC_NAMES[codec];
  const channels = (codec === "ac3" || codec === "eac3") && track.channels ? Math.min(track.channels, 6) : track.channels;
  return [shortLanguage(language), name, channelLayout(channels)].filter(Boolean).join(" ");
}

/** What a corrected track is named in the export: `override` (typed in its
 * file's detail), else per the export options -- undefined for its source's
 * own name. `language`: its language once exported. */
export function exportTitle({
  track,
  language,
  options,
  override,
}: {
  track: TrackInfo;
  language: string | null;
  options: ExportOptions;
  override?: string;
}): string | undefined {
  if (override) return override;
  if (options.naming === "auto") return autoTrackName(track, language, options.codec);
  if (options.naming === "custom") return options.customNames[language ?? ""] || undefined;
  return undefined;
}

/** The export options a mode's export follows: the remembered codec and
 * naming, and the names typed in per language (`customNames`, the mode's). */
export function useExportOptions() {
  const codec = useExportCodec();
  const naming = useTrackNaming();
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  return { codec, naming, customNames, setCustomNames };
}

export type ExportOptions = ReturnType<typeof useExportOptions>;

/** "Export : à côté des originaux · Opus · noms automatiques" in a mode's
 * footer, and "Modifier…" opening the export options. `languages`: those of
 * the tracks to correct (a custom name each); `example`: a track named
 * automatically, to show what that gives. */
export function ExportChooser({
  outputDir,
  onOutputDirChange,
  options,
  languages,
  example,
  disabled,
}: {
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  options: ExportOptions;
  languages: (string | null)[];
  example: string | null;
  disabled: boolean;
}) {
  const t = useT();
  const e = t.exportOptions;
  const [open, setOpen] = useState(false);
  return (
    <div className="batch-output">
      <span className="batch-output-label">{e.label}</span>
      <span className={outputDir ? "batch-output-dir batch-output-path" : "batch-output-dir"} title={outputDir ?? undefined}>
        {outputDir ?? t.batch.nextToOriginals}
      </span>
      <span className="batch-output-format">
        · {e.codecShort[options.codec]} · {e.namingShort[options.naming]}
      </span>
      <button className="small-button" disabled={disabled} title={e.editHint} onClick={() => setOpen(true)}>
        {e.edit}
      </button>
      {/* At the page's root: inside the footer (a .panel), it took its look. */}
      {open &&
        createPortal(
          <ExportDialog
            outputDir={outputDir}
            onOutputDirChange={onOutputDirChange}
            options={options}
            languages={languages}
            example={example}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

function ExportDialog({
  outputDir,
  onOutputDirChange,
  options,
  languages,
  example,
  onClose,
}: {
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  options: ExportOptions;
  languages: (string | null)[];
  example: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const e = t.exportOptions;
  return (
    <Dialog onClose={onClose} closeOnBackdrop className="export-options-panel" labelledBy="export-options-title">
      <DialogHeader id="export-options-title" title={e.title} onClose={onClose} />

      <Setting label={e.folder} hint={e.folderHint}>
        <span className="export-options-folder">
          <span className={outputDir ? "batch-output-dir batch-output-path" : "batch-output-dir"} title={outputDir ?? undefined}>
            {outputDir ?? t.batch.nextToOriginals}
          </span>
          <button
            className="small-button"
            onClick={async () => {
              const dir = await pickFolder(outputDir);
              if (dir) onOutputDirChange(dir);
            }}
          >
            {t.batch.chooseFolder}
          </button>
          {outputDir && (
            <button className="small-button" onClick={() => onOutputDirChange(null)} title={t.batch.backNextToOriginalsHint}>
              {t.batch.backNextToOriginals}
            </button>
          )}
        </span>
      </Setting>

      <Setting label={e.codec} hint={e.codecHint}>
        <Select
          label={e.codec}
          value={options.codec}
          options={EXPORT_CODECS.map((codec) => ({ value: codec, label: e.codecs[codec] }))}
          onChange={saveExportCodec}
        />
      </Setting>

      <Setting label={e.naming} hint={e.namingHint} note={options.naming === "auto" && example ? e.example(example) : undefined}>
        <PillSwitch
          className="pill-switch-wide"
          label={e.naming}
          options={TRACK_NAMINGS.map((naming) => [naming, e.namings[naming]] as const)}
          value={options.naming}
          onChange={saveTrackNaming}
        />
        {options.naming === "custom" &&
          languages.map((language) => (
            <label key={language ?? ""} className="export-options-name">
              <span>{e.customFor(languageLabel(language))}</span>
              <input
                {...FIELD_PROPS}
                type="text"
                value={options.customNames[language ?? ""] ?? ""}
                placeholder={e.customEmpty}
                onChange={(ev) => options.setCustomNames((names) => ({ ...names, [language ?? ""]: ev.target.value }))}
              />
            </label>
          ))}
      </Setting>
    </Dialog>
  );
}

/** Under a detail's tracks: each corrected track's name in the export, per
 * the export options (the placeholder), or as typed for this file only. */
export function ExportNames({
  rows,
  disabled,
  onChange,
}: {
  rows: { index: number; label: string; value: string; shown: string | null }[];
  disabled: boolean;
  onChange: (index: number, value: string) => void;
}) {
  const t = useT();
  const e = t.exportOptions;
  return (
    <div className="detail-names" title={e.trackNamesHint}>
      <span className="detail-names-title">{e.trackNames}</span>
      {rows.map((row) => (
        <label key={row.index} className="detail-name-row">
          <span>{row.label}</span>
          <input
            {...FIELD_PROPS}
            type="text"
            value={row.value}
            placeholder={row.shown ?? e.noName}
            disabled={disabled}
            onChange={(ev) => onChange(row.index, ev.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
