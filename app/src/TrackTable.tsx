import type { TrackInfo } from "./api";
import { useT } from "./i18n";

/** A file's audio tracks, one row each: index, language, codec, then either
 * the reference / track-to-correct picks (with `onReference`) or, read-only,
 * the channel count (`showChannels`). The single-file view and the batch
 * dialogs all show tracks this way; each keeps its own look (`className`). */
export function TrackTable({
  tracks,
  className,
  reference,
  targets = [],
  onReference,
  onToggleTarget,
  showChannels = false,
  radioName = "reference",
}: {
  tracks: TrackInfo[];
  className?: string;
  reference?: number | null;
  targets?: number[];
  onReference?: (index: number) => void;
  onToggleTarget?: (index: number) => void;
  showChannels?: boolean;
  /** Radio group name: unique per table on screen. */
  radioName?: string;
}) {
  const t = useT();
  const picking = onReference !== undefined;
  return (
    <table className={className}>
      <thead>
        <tr>
          <th>{t.tracks.track}</th>
          <th>{t.tracks.language}</th>
          <th>{t.tracks.codec}</th>
          {showChannels && <th>{t.tracks.channels}</th>}
          {picking && <th className="track-pick">{t.tracks.referenceShort}</th>}
          {picking && <th className="track-pick">{t.common.toCorrect}</th>}
        </tr>
      </thead>
      <tbody>
        {tracks.map((tr) => (
          <tr key={tr.index}>
            <td>@{tr.index}</td>
            <td>{tr.language ?? "?"}</td>
            <td>{tr.codec ?? "?"}</td>
            {showChannels && <td>{tr.channels ?? "?"}</td>}
            {picking && (
              <td className="track-pick">
                <input type="radio" name={radioName} checked={reference === tr.index} onChange={() => onReference(tr.index)} />
              </td>
            )}
            {picking && (
              <td className="track-pick">
                <input
                  type="checkbox"
                  disabled={reference === tr.index}
                  checked={targets.includes(tr.index)}
                  onChange={() => onToggleTarget?.(tr.index)}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
