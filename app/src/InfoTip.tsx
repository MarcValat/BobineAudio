import type { ReactNode } from "react";
import "./InfoTip.css";

/** A small "?" that shows `children` on hover or keyboard focus -- usage
 * hints stay one glance away instead of taking a line of the layout.
 * `align` picks which edge of the icon the bubble lines up with, so it can
 * open away from the side of the screen it sits near. */
export function InfoTip({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label="Aide">
      ?
      <span className={`info-tip-bubble ${align}`} role="tooltip">
        {children}
      </span>
    </span>
  );
}
