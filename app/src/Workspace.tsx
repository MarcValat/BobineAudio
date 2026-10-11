import type { ReactNode } from "react";
import { moved, RevealButton, writtenFile, type ExportFields } from "./batchShared";
import { LogPanel } from "./LogPanel";
import { basename } from "./paths";
import { useT } from "./i18n";
import "./Workspace.css";

/** How a list row's badge is tinted: what it's at (see rowState), or a
 * warning for a file whose tracks need checking. */
export type BadgeKind = "idle" | "queued" | "running" | "analyzed" | "exported" | "error" | "warning";

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

/** Under a detail: how its export went (running, the file written with its
 * folder, the error, cancelled), with its log. Nothing before an export. */
export function DetailExport({ entry }: { entry: ExportFields | null | undefined }) {
  const t = useT();
  if (!entry || entry.exportStatus === "idle") return null;
  const written = writtenFile(entry);
  return (
    <div className={`detail-export batch-status-${entry.exportStatus}`}>
      {entry.exportStatus === "running" && t.common.exportRunning}
      {entry.exportStatus === "done" && written && (
        <span className="render-success" title={written}>
          {t.single.written(basename(written))}
        </span>
      )}
      {entry.exportStatus === "error" && (entry.exportError ?? t.common.error)}
      {entry.exportStatus === "cancelled" && t.single.exportCancelled}
      <RevealButton file={written} />
      <LogPanel lines={entry.exportLog} />
    </div>
  );
}
