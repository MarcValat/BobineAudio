import { cancelJob, startPrefetchJob } from "./api";
import { runJob } from "./jobs";
import { FULL_TRACK_BUCKETS } from "./peaks";

// A listed file's audio tracks are decoded and analyzed ahead, in the
// background, one file at a time and in one pass over each (the engine's
// /jobs/prefetch): by the time "Analyser" is clicked, the work is mostly
// done -- measured on a 26 min episode, the analysis then takes 0.2 s
// instead of 18 -- and so are the waveforms (the same pass draws them). An
// analysis reaching a file first just waits for what's under way and
// decodes the rest (the engine never does a track twice).

interface Pending {
  path: string;
  indices: number[];
}

const queue: Pending[] = [];
let running: { path: string; job: string | null; done: Promise<void> } | null = null;

/** Starts the next file of the queue, if none is being done. */
function pump(): void {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  const current: { path: string; job: string | null; done: Promise<void> } = { path: next.path, job: null, done: Promise.resolve() };
  current.done = runJob(
    startPrefetchJob(next.path, next.indices, FULL_TRACK_BUCKETS),
    () => {},
    (id) => (current.job = id),
  )
    .then(() => {})
    .catch(() => {
      // only ahead of time: an analysis does what's missing itself
    })
    .finally(() => {
      running = null;
      pump();
    });
  running = current;
}

/** Queues `path`'s tracks (`indices`) to be decoded ahead, after the files
 * already waiting. */
export function prefetchTracks(path: string, indices: number[]): void {
  if (indices.length === 0 || running?.path === path || queue.some((p) => p.path === path)) return;
  queue.push({ path, indices });
  pump();
}

/** These files left the list: not decoded ahead any more (the one being
 * done is stopped). */
export function dropPrefetch(paths: string[]): void {
  for (let i = queue.length - 1; i >= 0; i--) if (paths.includes(queue[i].path)) queue.splice(i, 1);
  if (running && paths.includes(running.path) && running.job) cancelJob(running.job).catch(() => {});
}

/** Right before analyzing `path`: its tracks (`indices`) decoded now, in
 * one pass -- ahead of the files still waiting in the queue, or by waiting
 * for its own run if it's the one under way. */
export async function prefetchNow(path: string, indices: number[]): Promise<void> {
  const waiting = queue.findIndex((p) => p.path === path);
  if (waiting !== -1) queue.splice(waiting, 1);
  if (running?.path === path) {
    await running.done;
    // Its run covered every track of the file.
    return;
  }
  await runJob(startPrefetchJob(path, indices, FULL_TRACK_BUCKETS), () => {}).catch(() => {});
}
