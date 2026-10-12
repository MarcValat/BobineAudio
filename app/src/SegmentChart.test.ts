import { describe, expect, it } from "vitest";
import type { SegmentOut } from "./api";
import { drawnOffsets, formatOffsetMs, formatTime, offsetRange, offsetTicks, segmentOffsetLabel } from "./SegmentChart";
import { peaksToPath } from "./Waveform";

const seg = (offset_start: number, offset_end: number, is_drift: boolean): SegmentOut => ({
  start_s: 0,
  end_s: 10,
  offset_start,
  offset_end,
  is_drift,
  confidence: 1,
});

describe("formatOffsetMs", () => {
  it("signs an offset in milliseconds", () => {
    expect(formatOffsetMs(1.452)).toBe("+1452 ms");
    expect(formatOffsetMs(-0.036)).toBe("−36 ms");
  });

  it("keeps a decimal under 10 ms, and says 0 for less than 0.05 ms", () => {
    expect(formatOffsetMs(0.0004)).toBe("+0.4 ms");
    expect(formatOffsetMs(0.005)).toBe("+5.0 ms");
    expect(formatOffsetMs(0.00004)).toBe("0 ms");
    expect(formatOffsetMs(-0.00004)).toBe("0 ms");
  });
});

describe("segmentOffsetLabel / drawnOffsets", () => {
  it("draws and labels a constant flat, at its mean", () => {
    expect(drawnOffsets(seg(1, 1.1, false))).toEqual([1.05, 1.05]);
    expect(segmentOffsetLabel(seg(1, 1.1, false))).toBe("+1050 ms");
  });

  it("keeps a drift's slope", () => {
    expect(drawnOffsets(seg(1, 2, true))).toEqual([1, 2]);
    expect(segmentOffsetLabel(seg(1, 2, true))).toBe("+1000 ms → +2000 ms");
  });
});

describe("offsetRange / offsetTicks", () => {
  it("always includes 0, with room above and below", () => {
    const [min, max] = offsetRange([1, 2]);
    expect(min).toBeCloseTo(-0.3);
    expect(max).toBeCloseTo(2.3);
    expect(offsetRange([])).toEqual([-1.3, 1.3]);
  });

  it("puts round ticks over the range", () => {
    expect(offsetTicks(-0.3, 2.3)).toEqual([0, 1, 2]);
    const ticks = offsetTicks(0, 1);
    expect(ticks).toHaveLength(6);
    ticks.forEach((tick, i) => expect(tick).toBeCloseTo(i * 0.2));
    expect(offsetTicks(1, 1)).toEqual([]);
  });
});

describe("formatTime", () => {
  it("shows minutes and seconds", () => {
    expect(formatTime(65.4)).toBe("1:05");
    expect(formatTime(3599.6)).toBe("60:00");
    expect(formatTime(-3)).toBe("0:00");
  });
});

describe("peaksToPath", () => {
  it("outlines the peaks, top then bottom", () => {
    expect(peaksToPath([-1], [1], 0, 10, 20)).toBe("M 5.0,0.0 L 5.0,20.0 Z");
    expect(peaksToPath([], [], 0, 10, 20)).toBe("");
  });
});
