import { describe, expect, it } from "vitest";
import type { SubtitleInfo } from "./api";
import { assignSubtitles, subtitlesFor, takenByOthers } from "./subtitles";
import { toggled } from "./util";

const sub = (index: number, language: string | null, forced: boolean, shiftable = true): SubtitleInfo => ({
  index,
  codec: shiftable ? "ass" : "hdmv_pgs_subtitle",
  language,
  title: null,
  forced,
  shiftable,
});

const subs = [sub(0, "fre", true), sub(1, "fre", false), sub(2, "eng", true), sub(3, "fre", true, false)];

describe("subtitlesFor", () => {
  it("takes the language's forced subtitles by default", () => {
    expect(subtitlesFor(subs, "fre")).toEqual([0]);
  });

  it("takes all of the language's, or none", () => {
    expect(subtitlesFor(subs, "fre", "all")).toEqual([0, 1]);
    expect(subtitlesFor(subs, "fre", "none")).toEqual([]);
  });

  it("leaves out image subtitles, and a track without language", () => {
    expect(subtitlesFor(subs, "fre", "all")).not.toContain(3);
    expect(subtitlesFor(subs, null, "all")).toEqual([]);
  });
});

describe("assignSubtitles / takenByOthers", () => {
  it("gives a subtitle track to the first audio track wanting it only", () => {
    const assigned = assignSubtitles([{ index: 1 }, { index: 2 }], () => [0, 1]);
    expect(assigned).toEqual({ 1: [0, 1], 2: [] });
    expect(takenByOthers(assigned, 2)).toEqual([0, 1]);
    expect(takenByOthers(assigned, 1)).toEqual([]);
  });
});

describe("toggled", () => {
  it("adds an item, or removes it", () => {
    expect(toggled([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggled([1, 2], 1)).toEqual([2]);
  });
});
