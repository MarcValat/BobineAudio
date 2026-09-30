import { useSyncExternalStore } from "react";
import { currentLanguage, t } from "./i18n";

/** The engine sidecar's local HTTP address (see src-tauri/src/lib.rs). */
export const ENGINE_URL = "http://127.0.0.1:8756";

// Asked often, so requests go through as soon as the engine answers (it's
// up in about a second); a tiny local request, only while starting.
const HEALTH_POLL_INTERVAL_MS = 100;
const HEALTH_POLL_ATTEMPTS = 200; // 200 * 100ms = 20s before giving up

/** "starting": not answering yet; "unreachable": gave up waiting (see retryEngine). */
export type EngineStatus = "starting" | "ready" | "unreachable";

let status: EngineStatus = "starting";
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setStatus(next: EngineStatus): void {
  status = next;
  listeners.forEach((listener) => listener());
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${ENGINE_URL}/health`)).ok;
  } catch {
    return false;
  }
}

/** Waits for the engine to answer, then tells it the UI's language before
 * anything else reaches it (a job's first log lines would otherwise come
 * out in its default French). */
function waitForEngine(): Promise<void> {
  setStatus("starting");
  const attempt = new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const poll = async () => {
      if (await healthy()) {
        await fetch(`${ENGINE_URL}/language`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: currentLanguage() }),
        }).catch(() => {});
        setStatus("ready");
        resolve();
      } else if (++attempts >= HEALTH_POLL_ATTEMPTS) {
        setStatus("unreachable");
        reject(new Error(t().startup.unreachable));
      } else {
        setTimeout(poll, HEALTH_POLL_INTERVAL_MS);
      }
    };
    poll();
  });
  attempt.catch(() => {}); // only the requests waiting on it report it
  return attempt;
}

/** Resolves once the engine answers (at once when it already has); every
 * request to it waits on this, so the UI is usable while it starts: a
 * file opened meanwhile is just read a moment later. Rejects if it never
 * answers. Starts watching on the first call. */
export function engineReady(): Promise<void> {
  ready ??= waitForEngine();
  return ready;
}

/** After "unreachable": wait for the engine again (the requests made from
 * now on wait on this new attempt). */
export function retryEngine(): void {
  if (status === "unreachable") ready = waitForEngine();
}

/** The engine's state, for the startup indicator; re-renders on changes. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}
