import type { ReactNode } from "react";
import { moved } from "./batchShared";
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
  state,
  badge,
  badgeKind,
  selected,
  onSelect,
  actions,
}: {
  name: string;
  path: string;
  detail: ReactNode;
  /** rowState's value, for the bar. */
  state: string;
  badge: string;
  badgeKind: BadgeKind;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  return (
    <li className={`list-row list-row-state-${state}${selected ? " selected" : ""}`}>
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
