import type { TrackInfo } from "./api";

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
  const picking = onReference !== undefined;
  return (
    <table className={className}>
      <thead>
        <tr>
          <th>Piste</th>
          <th>Langue</th>
          <th>Codec</th>
          {showChannels && <th>Canaux</th>}
          {picking && <th className="track-pick">Réf.</th>}
          {picking && <th className="track-pick">À corriger</th>}
        </tr>
      </thead>
      <tbody>
        {tracks.map((t) => (
          <tr key={t.index}>
            <td>@{t.index}</td>
            <td>{t.language ?? "?"}</td>
            <td>{t.codec ?? "?"}</td>
            {showChannels && <td>{t.channels ?? "?"}</td>}
            {picking && (
              <td className="track-pick">
                <input type="radio" name={radioName} checked={reference === t.index} onChange={() => onReference(t.index)} />
              </td>
            )}
            {picking && (
              <td className="track-pick">
                <input
                  type="checkbox"
                  disabled={reference === t.index}
                  checked={targets.includes(t.index)}
                  onChange={() => onToggleTarget?.(t.index)}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
