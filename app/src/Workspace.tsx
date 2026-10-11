import { useEffect, useRef, useState, type ReactNode } from "react";
import { probe, type SubtitleInfo, type TrackInfo } from "./api";
import { moved } from "./batchShared";
import type { RunStatus } from "./jobs";
import { errorMessage } from "./util";
import { useT } from "./i18n";
import "./Workspace.css";

/** How a list row's badge is tinted: what it's at (see rowState), or a
 * warning for a file whose tracks need checking. */
export type BadgeKind = "idle" | "queued" | "running" | "analyzed" | "exported" | "error" | "warning";

/** A row's badge words for where its analyses and export are at. */
export interface RunLabels {
  exporting: string;
  running: string;
  pending: string;
  exported: string;
  exportFailed: string;
  failed: string;
  cancelled: string;
  analyzed: string;
}

/** A row's badge from its analyses (a file's corrected tracks, a pair's)
 * and its export: what's running first, then what went wrong, then how far
 * it got. Null while none has run: the mode says what's missing. */
export function runBadge(statuses: (RunStatus | undefined)[], exportStatus: RunStatus | undefined, l: RunLabels): [string, BadgeKind] | null {
  if (exportStatus === "running") return [l.exporting, "running"];
  if (statuses.includes("running")) return [l.running, "running"];
  if (statuses.includes("pending")) return [l.pending, "queued"];
  if (exportStatus === "done") return [l.exported, "exported"];
  if (exportStatus === "error") return [l.exportFailed, "error"];
  if (statuses.includes("error")) return [l.failed, "error"];
  if (statuses.length > 0 && statuses.every((s) => s === "done")) {
    return [exportStatus === "cancelled" ? l.cancelled : l.analyzed, "analyzed"];
  }
  return null;
}

/** A listed file's tracks, or why it can't be read. */
export interface FileProbe {
  tracks: TrackInfo[] | null;
  subtitles: SubtitleInfo[];
  error: string | null;
}

/** Every file of `paths` read once, as soon as it's listed (absent: not
 * read yet). */
export function useProbes(paths: string[]): Record<string, FileProbe> {
  const [probes, setProbes] = useState<Record<string, FileProbe>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const path of paths) {
      if (requested.current.has(path)) continue;
      requested.current.add(path);
      probe(path)
        .then((res) => setProbes((p) => ({ ...p, [path]: { tracks: res.tracks, subtitles: res.subtitles ?? [], error: null } })))
        .catch((err) => setProbes((p) => ({ ...p, [path]: { tracks: null, subtitles: [], error: errorMessage(err) } })));
    }
  }, [paths]);
  return probes;
}

/** One file of the workspace's list: its name (the full path on hover),
 * a line saying what's used of it, and a badge saying where it stands, with
 * a colored bar at its left. Clicking it shows it in the detail; its own
 * buttons (move, remove) show on hover, focus and selection. */
export function ListRow({
  name,
  path,
  detail,
  className = "",
  state,
  badge,
  badgeKind,
  selected,
  onSelect,
  actions,
}: {
  name: ReactNode;
  /** On hover: the full path (a pair's two, one per line). */
  path: string;
  detail: ReactNode;
  /** A look of its own (a pair's). */
  className?: string;
  /** rowState's value, for the bar. */
  state: string;
  badge: string;
  badgeKind: BadgeKind;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  return (
    <li className={`list-row list-row-state-${state}${selected ? " selected" : ""} ${className}`}>
      <button className="list-row-main" onClick={onSelect} aria-current={selected || undefined} title={path}>
        <span className="list-row-bar" />
        <span className="list-row-text">
          <span className="list-row-name">{name}</span>
          <span className="list-row-detail">{detail}</span>
        </span>
        <span className="list-row-status">
          <span className={`list-badge list-badge-${badgeKind}`}>{badge}</span>
          {/* Something's running on it: the app's spinner (the engine
              doesn't say how far along it is). */}
          {badgeKind === "running" && <span className="spinner spinner-small" aria-hidden="true" />}
        </span>
      </button>
      {actions && <span className="list-row-actions">{actions}</span>}
    </li>
  );
}

/** A row's ↑ ↓ ✕: moves it within the list, or drops it. The arrows carry
 * U+FE0E, which asks for the plain text glyph: Windows may otherwise draw
 * them as colored emoji. */
export function MoveButtons({
  count,
  index,
  disabled,
  onChange,
}: {
  count: number;
  index: number;
  disabled: boolean;
  onChange: (update: <T>(items: T[]) => T[]) => void;
}) {
  const t = useT();
  return (
    <>
      <button
        className="small-button"
        onClick={() => onChange((f) => moved(f, index, index - 1))}
        disabled={disabled || index === 0}
        title={t.batch.moveUp}
        aria-label={t.batch.moveUp}
      >
        {"↑︎"}
      </button>
      <button
        className="small-button"
        onClick={() => onChange((f) => moved(f, index, index + 1))}
        disabled={disabled || index === count - 1}
        title={t.batch.moveDown}
        aria-label={t.batch.moveDown}
      >
        {"↓︎"}
      </button>
      <button
        className="small-button"
        onClick={() => onChange((f) => f.filter((_, i) => i !== index))}
        disabled={disabled}
        title={t.common.remove}
        aria-label={t.common.remove}
      >
        ✕
      </button>
    </>
  );
}

/** One pair of the pairs list: a file row (ListRow, the same as a
 * multitrack file's) whose two lines are its reference file and its file to
 * correct; on hover, each file's own ↑ ↓ ✕ (they move within their own
 * column) take the badge's place, one set per line. */
export function PairRow({
  reference,
  candidate,
  referenceActions,
  candidateActions,
  state,
  badge,
  badgeKind,
  selected,
  onSelect,
}: {
  reference: { name: string; path?: string; missing: string };
  candidate: { name: string; path?: string; missing: string };
  referenceActions?: ReactNode;
  candidateActions?: ReactNode;
  state: string;
  badge: string;
  badgeKind: BadgeKind;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const line = (kind: "ref" | "cand", file: { name: string; path?: string; missing: string }) => (
    <>
      <span className={`pair-row-kind pair-row-kind-${kind}`}>{kind === "ref" ? t.pairs.refShort : t.pairs.candShort}</span>
      <span className={`pair-row-name${file.path ? "" : " pair-row-missing"}`}>{file.path ? file.name : file.missing}</span>
    </>
  );
  return (
    <ListRow
      className="pair-row"
      name={line("ref", reference)}
      detail={line("cand", candidate)}
      path={[reference.path, candidate.path].filter(Boolean).join("\n")}
      state={state}
      badge={badge}
      badgeKind={badgeKind}
      selected={selected}
      onSelect={onSelect}
      actions={
        <span className="pair-row-actions">
          <span>{reference.path && referenceActions}</span>
          <span>{candidate.path && candidateActions}</span>
        </span>
      }
    />
  );
}
