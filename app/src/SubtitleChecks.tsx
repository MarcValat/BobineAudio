import type { SubtitleInfo } from "./api";
import { subtitleDetails, subtitleLabel } from "./subtitles";
import { useT } from "./i18n";

/** One checkbox per subtitle track of a file: the ones retimed along with
 * one corrected audio track (`chosen`). A track `taken` by another audio
 * track, or an image one (PGS, VobSub: can't be retimed), can't be ticked;
 * its tooltip says why. Single-file view and the batch "Choisir" dialog. */
export function SubtitleChecks({
  subtitles,
  chosen,
  taken,
  disabled = false,
  onToggle,
}: {
  subtitles: SubtitleInfo[];
  chosen: number[];
  taken: number[];
  disabled?: boolean;
  onToggle: (index: number) => void;
}) {
  const t = useT();
  return (
    <>
      {subtitles.map((s) => {
        const elsewhere = taken.includes(s.index);
        return (
          <label
            key={s.index}
            title={!s.shiftable ? t.subtitles.unshiftable : elsewhere ? t.subtitles.takenElsewhere : subtitleDetails(s)}
          >
            <input
              type="checkbox"
              checked={chosen.includes(s.index)}
              disabled={disabled || !s.shiftable || elsewhere}
              onChange={() => onToggle(s.index)}
            />
            {subtitleLabel(s)}
          </label>
        );
      })}
    </>
  );
}
