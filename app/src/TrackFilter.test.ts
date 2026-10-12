import { describe, expect, it } from "vitest";
import type { TrackInfo } from "./api";
import { ALL_TRACKS, defaultPick, matchesKey, resolveTracks, trackOptions } from "./TrackFilter";

const track = (index: number, language: string | null, title: string | null = null): TrackInfo => ({
  index,
  codec: "aac",
  language,
  title,
  channels: 2,
  sample_rate: 48000,
  export_codec: "Opus",
  start_time: 0,
});

describe("matchesKey", () => {
  const vf = track(1, "fre", "VF");
  it("matches by number, language or name", () => {
    expect(matchesKey(vf, ALL_TRACKS)).toBe(true);
    expect(matchesKey(vf, "index:1")).toBe(true);
    expect(matchesKey(vf, "index:2")).toBe(false);
    expect(matchesKey(vf, "lang:fre")).toBe(true);
    expect(matchesKey(vf, "lang:eng")).toBe(false);
    expect(matchesKey(vf, "name:VF")).toBe(true);
    expect(matchesKey(vf, "unknown:VF")).toBe(false);
  });

  it("keeps what follows the first colon whole (a name with a colon)", () => {
    expect(matchesKey(track(0, null, "VF: forcés"), "name:VF: forcés")).toBe(true);
  });
});

describe("trackOptions", () => {
  it("lists every number, language and name of the files", () => {
    const options = trackOptions([
      [track(0, "jpn"), track(1, "fre", "VF")],
      [track(0, "jpn"), track(1, "fre", "VF"), track(2, "eng")],
    ]);
    expect(options.indices.map((o) => o.key)).toEqual(["index:0", "index:1", "index:2"]);
    expect(options.indices[0].detail).toBe("jpn · aac");
    expect(options.languages.map((o) => o.key)).toEqual(["lang:jpn", "lang:fre", "lang:eng"]);
    expect(options.names.map((o) => o.key)).toEqual(["name:VF"]);
  });
});

describe("defaultPick", () => {
  it("takes the first track's language as the reference, every other language to correct", () => {
    expect(defaultPick([track(0, "jpn"), track(1, "fre"), track(2, "eng"), track(3, "fre")])).toEqual({
      reference: "lang:jpn",
      targets: ["lang:fre", "lang:eng"],
    });
  });

  it("picks by number without languages", () => {
    expect(defaultPick([track(0, null), track(1, null), track(2, null)])).toEqual({
      reference: "index:0",
      targets: ["index:1", "index:2"],
    });
  });

  it("picks a pair's tracks to correct in the other file", () => {
    expect(defaultPick([track(0, "jpn")], [track(0, "fre")])).toEqual({ reference: "lang:jpn", targets: ["lang:fre"] });
    // No language: its own first track alone, its second one among several.
    expect(defaultPick([track(0, null)], [track(0, null)])).toEqual({ reference: "index:0", targets: ["index:0"] });
    expect(defaultPick([track(0, null)], [track(0, null), track(1, null)])).toEqual({ reference: "index:0", targets: ["index:1"] });
  });
});

describe("resolveTracks", () => {
  const tracks = [track(0, "jpn"), track(1, "fre"), track(2, "eng")];

  it("finds the reference and the tracks to correct by language", () => {
    const r = resolveTracks(tracks, "lang:jpn", ["lang:fre"]);
    expect(r.reference?.index).toBe(0);
    expect(r.targets.map((t) => t.index)).toEqual([1]);
    expect(r).toMatchObject({ issues: [], manual: false, auto: false });
  });

  it("flags a track to correct the file doesn't have", () => {
    const r = resolveTracks(tracks, "lang:jpn", ["lang:fre", "lang:ger"]);
    expect(r.targets.map((t) => t.index)).toEqual([1]);
    expect(r.issues).toHaveLength(1);
  });

  it("corrects every other track for “all”", () => {
    expect(resolveTracks(tracks, "lang:jpn", [ALL_TRACKS]).targets.map((t) => t.index)).toEqual([1, 2]);
  });

  it("falls back to the first track and corrects all others when the reference names none", () => {
    const r = resolveTracks(tracks, "lang:kor", ["lang:fre"]);
    expect(r.reference?.index).toBe(0);
    expect(r.targets.map((t) => t.index)).toEqual([1, 2]);
    expect(r.auto).toBe(true);
  });

  it("takes the first of several matches as the reference, flagged", () => {
    const r = resolveTracks([track(0, "jpn"), track(1, "jpn"), track(2, "fre")], "lang:jpn", ["lang:fre"]);
    expect(r.reference?.index).toBe(0);
    expect(r.auto).toBe(true);
  });

  it("follows the tracks ticked by hand", () => {
    const r = resolveTracks(tracks, "lang:jpn", ["lang:fre"], { reference: 2, targets: [0] });
    expect(r.reference?.index).toBe(2);
    expect(r.targets.map((t) => t.index)).toEqual([0]);
    expect(r.manual).toBe(true);
  });

  it("has no reference in a file without tracks", () => {
    expect(resolveTracks([], "lang:jpn", ["lang:fre"]).reference).toBeNull();
  });
});
