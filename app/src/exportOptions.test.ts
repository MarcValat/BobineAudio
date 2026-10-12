import { describe, expect, it } from "vitest";
import type { TrackInfo } from "./api";
import { exportTitle, type ExportOptions } from "./exportOptions";
import { shortLanguage } from "./languages";
import type { ExportCodec, TrackNaming } from "./settings";

const track = (channels: number | null, export_codec = "Opus"): TrackInfo => ({
  index: 1,
  codec: "aac",
  language: "fre",
  title: "Français",
  channels,
  sample_rate: 48000,
  export_codec,
  start_time: 0,
});

const options = (naming: TrackNaming, codec: ExportCodec = "auto", customNames: Record<string, string> = {}): ExportOptions => ({
  codec,
  naming,
  customNames,
  setCustomNames: () => {},
});

describe("exportTitle, automatic names", () => {
  it("names a track by language, export codec and channels", () => {
    expect(exportTitle({ track: track(2), language: "fre", options: options("auto") })).toBe("FR Opus 2.0");
    expect(exportTitle({ track: track(6, "E-AC3"), language: "jpn", options: options("auto") })).toBe("JP E-AC3 5.1");
  });

  it("names the codec asked instead of the source's", () => {
    expect(exportTitle({ track: track(2), language: "fre", options: options("auto", "flac") })).toBe("FR FLAC 2.0");
    expect(exportTitle({ track: track(1), language: "eng", options: options("auto", "aac") })).toBe("EN AAC 1.0");
  });

  it("says 5.1 for a 7.1 track mixed down for AC3 / E-AC3", () => {
    expect(exportTitle({ track: track(8), language: "fre", options: options("auto", "ac3") })).toBe("FR AC3 5.1");
    expect(exportTitle({ track: track(8), language: "fre", options: options("auto", "eac3") })).toBe("FR E-AC3 5.1");
    expect(exportTitle({ track: track(8), language: "fre", options: options("auto", "opus") })).toBe("FR Opus 7.1");
  });

  it("leaves out what isn't known", () => {
    expect(exportTitle({ track: track(null), language: "fre", options: options("auto") })).toBe("FR Opus");
    expect(exportTitle({ track: track(2), language: null, options: options("auto") })).toBe("Opus 2.0");
    expect(exportTitle({ track: track(3), language: "fre", options: options("auto") })).toBe("FR Opus 3.0");
  });
});

describe("exportTitle, other namings", () => {
  it("keeps the source's own name", () => {
    expect(exportTitle({ track: track(2), language: "fre", options: options("source") })).toBeUndefined();
  });

  it("takes a custom name per language", () => {
    const custom = options("custom", "auto", { fre: "VF" });
    expect(exportTitle({ track: track(2), language: "fre", options: custom })).toBe("VF");
    expect(exportTitle({ track: track(2), language: "eng", options: custom })).toBeUndefined();
  });

  it("puts a name typed for the file first", () => {
    expect(exportTitle({ track: track(2), language: "fre", options: options("auto"), override: "VFF" })).toBe("VFF");
  });
});

describe("shortLanguage", () => {
  it("tags a language as releases do", () => {
    expect(shortLanguage("fre")).toBe("FR");
    expect(shortLanguage("jpn")).toBe("JP");
    expect(shortLanguage("kor")).toBe("KR");
    expect(shortLanguage("xyz")).toBe("XYZ");
    expect(shortLanguage(null)).toBeNull();
  });
});
