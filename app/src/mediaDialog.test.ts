import { beforeEach, describe, expect, it, vi } from "vitest";

// The files already in the output folder: what the engine would answer.
const existing = new Set<string>();
vi.mock("./api", () => ({ pathsExist: async (paths: string[]) => paths.map((p) => existing.has(p)) }));

/** planOutputPaths as on `platform` (its path rules are read once, from the user agent). */
async function planOn(platform: "Linux" | "Windows") {
  vi.resetModules();
  Object.defineProperty(window.navigator, "userAgent", { value: `Mozilla/5.0 (${platform})`, configurable: true });
  return (await import("./mediaDialog")).planOutputPaths;
}

beforeEach(() => existing.clear());

describe("planOutputPaths, next to the originals", () => {
  it("adds .synced", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/v/Film.mp4"], null)).toEqual(["/v/Film.synced.mkv"]);
  });

  it("keeps an episode number's dots", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/v/Show.S01E01.mkv"], null)).toEqual(["/v/Show.S01E01.synced.mkv"]);
  });

  it("numbers copies that would share a name", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/v/Film.mkv", "/v/Film.mp4"], null)).toEqual(["/v/Film.synced.mkv", "/v/Film.synced (2).mkv"]);
  });

  it("counts an output folder that is the originals' as next to them", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/v/Film.mkv"], "/v/")).toEqual(["/v/Film.synced.mkv"]);
  });
});

describe("planOutputPaths, in another folder", () => {
  it("keeps the original's name", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/v/Film.mp4"], "/out")).toEqual(["/out/Film.mkv"]);
  });

  it("adds .synced when a file there has that name", async () => {
    existing.add("/out/Film.mkv");
    const plan = await planOn("Linux");
    expect(await plan(["/v/Film.mkv"], "/out")).toEqual(["/out/Film.synced.mkv"]);
  });

  it("adds .synced when another copy of the batch takes the name", async () => {
    const plan = await planOn("Linux");
    expect(await plan(["/a/Film.mkv", "/b/Film.mkv"], "/out")).toEqual(["/out/Film.mkv", "/out/Film.synced.mkv"]);
  });

  it("ignores case and slashes on Windows only", async () => {
    const windows = await planOn("Windows");
    expect(await windows(["C:\\a\\Film.mkv", "C:\\b\\FILM.mkv"], "D:\\out")).toEqual(["D:\\out\\Film.mkv", "D:\\out\\FILM.synced.mkv"]);
    expect(await windows(["C:\\v\\Film.mkv"], "c:/V")).toEqual(["c:/V\\Film.synced.mkv"]);
    const linux = await planOn("Linux");
    expect(await linux(["/a/Film.mkv", "/b/FILM.mkv"], "/out")).toEqual(["/out/Film.mkv", "/out/FILM.mkv"]);
  });
});
