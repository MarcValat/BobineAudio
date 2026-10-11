import { retryEngine, useEngineStatus } from "./engine";
import { useT } from "./i18n";

/** The engine's state, top right, as a pill (as the mockup): "Moteur prêt"
 * with a green dot once it's up, a small spinner while it starts, the
 * failure and "Réessayer" if it never answers. The rest of the UI stays
 * usable meanwhile (see engineReady). */
export function EngineStatusBadge() {
  const t = useT();
  const status = useEngineStatus();
  if (status === "ready") {
    return (
      <span className="engine-status engine-status-ready" role="status">
        <span className="engine-status-dot" aria-hidden="true" />
        <span className="engine-status-text">{t.startup.ready}</span>
      </span>
    );
  }
  if (status === "starting") {
    return (
      <span className="engine-status" role="status">
        <span className="spinner spinner-small" aria-hidden="true" />
        <span className="engine-status-text">{t.startup.starting}</span>
      </span>
    );
  }
  return (
    <span className="engine-status engine-status-error" role="alert" title={t.startup.unreachable}>
      <span className="engine-status-text">{t.startup.unreachableShort}</span>
      <button className="small-button" onClick={retryEngine}>
        {t.common.retry}
      </button>
    </span>
  );
}
