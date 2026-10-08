import { LOW_CONFIDENCE_THRESHOLD } from "./SegmentChart";
import { useT } from "./i18n";

/** A segment's confidence at a glance (as in Bobine Subs): a thin bar
 * filled to it, green when reliable, red when it's to check (⚠ under
 * LOW_CONFIDENCE_THRESHOLD), the percentage next to it. */
export function ConfidenceGauge({ value }: { value: number }) {
  const t = useT();
  const percent = Math.round(value * 100);
  const weak = value < LOW_CONFIDENCE_THRESHOLD;
  return (
    <span className={`confidence${weak ? " confidence-weak" : ""}`} title={weak ? t.editor.lowConfidence : undefined}>
      <span className="confidence-bar" aria-hidden="true">
        <span className="confidence-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </span>
      <span className="confidence-value">{t.common.percent(percent)}</span>
      {/* Room kept on every row: the bars stay aligned. */}
      <span className="confidence-flag">{weak ? "⚠" : ""}</span>
    </span>
  );
}
