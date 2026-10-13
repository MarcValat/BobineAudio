import { describe, expect, it } from "vitest";
import { moved, nextStep, rowState, type AnalysisRun } from "./batchShared";
import type { RunStatus } from "./jobs";
import { runBadge, trackName } from "./Workspace";

const run = (status: RunStatus): AnalysisRun => ({ status, result: null, error: null, log: [] });

describe("moved", () => {
  it("moves an item up or down the list", () => {
    expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("leaves the list as is past its ends", () => {
    const list = ["a", "b"];
    expect(moved(list, 0, -1)).toBe(list);
    expect(moved(list, 1, 2)).toBe(list);
  });
});

describe("nextStep", () => {
  it("analyzes while something isn't analyzed, or is being", () => {
    expect(nextStep({ analyzing: false, missing: 1, exportable: 2, exported: 0 })).toBe("analyze");
    expect(nextStep({ analyzing: true, missing: 0, exportable: 2, exported: 0 })).toBe("analyze");
  });

  it("then exports what isn't exported yet, then nothing", () => {
    expect(nextStep({ analyzing: false, missing: 0, exportable: 2, exported: 1 })).toBe("export");
    expect(nextStep({ analyzing: false, missing: 0, exportable: 2, exported: 2 })).toBeNull();
  });
});

describe("rowState", () => {
  it("says what's running or waiting first", () => {
    expect(rowState([run("done"), run("running")], "idle", true)).toBe("running");
    expect(rowState([run("done")], "running", false)).toBe("running");
    expect(rowState([run("pending")], "error", false)).toBe("queued");
  });

  it("then what went wrong", () => {
    expect(rowState([run("done")], "idle", true)).toBe("error");
    expect(rowState([run("error"), run("done")], "idle", false)).toBe("error");
    expect(rowState([run("done")], "error", false)).toBe("error");
  });

  it("then how far it got", () => {
    expect(rowState([run("done")], "done", false)).toBe("exported");
    expect(rowState([run("done"), run("done")], "idle", false)).toBe("analyzed");
    expect(rowState([run("done"), undefined], "idle", false)).toBe("idle");
    expect(rowState([], "idle", false)).toBe("idle");
  });
});

describe("runBadge", () => {
  const labels = {
    exporting: "exporting",
    running: "running",
    pending: "pending",
    exported: "exported",
    exportFailed: "exportFailed",
    failed: "failed",
    cancelled: "cancelled",
    analyzed: "analyzed",
  };

  it("puts what's running first, then what went wrong, then how far it got", () => {
    expect(runBadge(["done"], "running", labels)).toEqual(["exporting", "running"]);
    expect(runBadge(["error", "running"], "idle", labels)).toEqual(["running", "running"]);
    expect(runBadge(["pending"], "idle", labels)).toEqual(["pending", "queued"]);
    expect(runBadge(["done"], "done", labels)).toEqual(["exported", "exported"]);
    expect(runBadge(["done"], "error", labels)).toEqual(["exportFailed", "error"]);
    expect(runBadge(["error", "done"], "idle", labels)).toEqual(["failed", "error"]);
    expect(runBadge(["done"], "cancelled", labels)).toEqual(["cancelled", "analyzed"]);
    expect(runBadge(["done", "done"], "idle", labels)).toEqual(["analyzed", "analyzed"]);
  });

  it("is null while nothing has run", () => {
    expect(runBadge([], "idle", labels)).toBeNull();
    expect(runBadge([undefined], undefined, labels)).toBeNull();
  });
});

describe("trackName", () => {
  it("names a track by number and language", () => {
    expect(trackName(1, { index: 1, language: "fre" } as never)).toBe("@1 fre");
    expect(trackName(2, { index: 2, language: null } as never)).toBe("@2");
    expect(trackName(3)).toBe("@3");
  });
});
