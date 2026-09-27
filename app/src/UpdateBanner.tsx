import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

/**
 * Checks GitHub Releases (see src-tauri/tauri.conf.json's
 * plugins.updater.endpoints) once on mount and, if a newer signed build
 * exists, offers to install it in place. Silently does nothing on failure
 * -- no network, the endpoint placeholder never filled in, GitHub briefly
 * unreachable -- since a background update check must never interrupt or
 * clutter the app over something this optional.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    check()
      .then((result) => {
        if (!cancelled && result) {
          setUpdate(result);
          setPhase("available");
        }
      })
      .catch(() => {
        // See docstring above -- deliberately silent.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function install() {
    if (!update) return;
    setPhase("downloading");
    setError(null);
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          setProgress((p) => ({ downloaded: p.downloaded + event.data.chunkLength, total: p.total }));
        }
      });
      setPhase("ready");
      await relaunch();
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (phase === "idle" || !update) return null;

  const percent = progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <div className="update-banner">
      {phase === "available" && (
        <>
          <span>Mise à jour disponible : v{update.version}</span>
          <button className="small-button" onClick={install}>
            Installer et redémarrer
          </button>
        </>
      )}
      {phase === "downloading" && <span>Téléchargement de la mise à jour... {percent !== null ? `${percent}%` : ""}</span>}
      {phase === "ready" && <span>Installé, redémarrage...</span>}
      {phase === "error" && <span className="error">Échec de la mise à jour : {error}</span>}
    </div>
  );
}
