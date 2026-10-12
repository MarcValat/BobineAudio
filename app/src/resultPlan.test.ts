import { describe, expect, it } from "vitest";
import type { SegmentOut } from "./api";
import { candidateSpansIn, planResult, silentRegions, skippedRegions } from "./resultPlan";

const seg = (start_s: number, end_s: number, offset_start: number, offset_end = offset_start): SegmentOut => ({
  start_s,
  end_s,
  offset_start,
  offset_end,
  is_drift: offset_start !== offset_end,
  confidence: 1,
});

describe("planResult", () => {
  it("orders the segments by time", () => {
    const plan = planResult([seg(50, 100, 0), seg(0, 50, 0)]);
    expect(plan.map((s) => s.start)).toEqual([0, 50]);
  });
});

describe("a constant offset, the candidate late by 2 s", () => {
  const plan = planResult([seg(0, 100, 2)]);

  it("plays the candidate 2 s further on", () => {
    expect(candidateSpansIn(plan, 10, 20, 102)).toEqual([{ start: 12, end: 22 }]);
  });

  it("skips the candidate's first 2 s and leaves nothing silent", () => {
    expect(skippedRegions(plan, 102)).toEqual([{ start: 0, end: 2 }]);
    expect(silentRegions(plan, 102)).toEqual([]);
  });
});

describe("a constant offset, the candidate early by 1 s", () => {
  const plan = planResult([seg(0, 100, -1)]);

  it("starts with 1 s of silence (nothing before the candidate's start)", () => {
    expect(silentRegions(plan, 99)).toEqual([{ start: 0, end: 1 }]);
    expect(candidateSpansIn(plan, 0, 10, 99)).toEqual([{ start: 0, end: 9 }]);
    expect(skippedRegions(plan, 99)).toEqual([]);
  });
});

describe("a jump", () => {
  it("cuts the candidate's extra content when the offset rises", () => {
    const plan = planResult([seg(0, 50, 0), seg(50, 100, 3)]);
    expect(skippedRegions(plan, 103)).toEqual([{ start: 50, end: 53 }]);
    expect(silentRegions(plan, 103)).toEqual([]);
  });

  it("fills the candidate's missing content with silence when it drops, never replaying it", () => {
    const plan = planResult([seg(0, 50, 0), seg(50, 100, -2)]);
    expect(silentRegions(plan, 98)).toEqual([{ start: 50, end: 52 }]);
    expect(skippedRegions(plan, 98)).toEqual([]);
    expect(candidateSpansIn(plan, 50, 60, 98)).toEqual([{ start: 50, end: 58 }]);
  });
});

describe("a candidate shorter than the reference", () => {
  it("ends in silence", () => {
    const plan = planResult([seg(0, 100, 0)]);
    expect(silentRegions(plan, 90)).toEqual([{ start: 90, end: 100 }]);
    expect(candidateSpansIn(plan, 80, 100, 90)).toEqual([{ start: 80, end: 90 }]);
  });
});

describe("a drift", () => {
  it("stretches the candidate span over the reference span", () => {
    // 0 s late at the start, 1 s late at the end: 101 s of candidate in 100 s.
    const plan = planResult([seg(0, 100, 0, 1)]);
    const [span] = candidateSpansIn(plan, 50, 60, 200);
    expect(span.start).toBeCloseTo(50.5);
    expect(span.end).toBeCloseTo(60.6);
  });
});
