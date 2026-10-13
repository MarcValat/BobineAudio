import { describe, expect, it } from "vitest";
import type { SegmentOut } from "./api";
import { ignoreLowConfidenceSegments, mergeSegment, sameState, splitSegment, toEditorState, toSegments } from "./segmentEdits";

const seg = (start_s: number, end_s: number, offset_start: number, offset_end: number, confidence: number): SegmentOut => ({
  start_s,
  end_s,
  offset_start,
  offset_end,
  is_drift: Math.abs(offset_end - offset_start) > 0.2,
  confidence,
});

// A constant, an unreliable constant, then a drift.
const segments = [seg(0, 10, 1, 1, 0.9), seg(10, 20, 2, 2, 0.2), seg(20, 30, 3, 3.5, 0.8)];
const state = toEditorState(segments);

describe("toEditorState / toSegments", () => {
  it("round-trips a segment list", () => {
    expect(toSegments(state)).toEqual(segments);
  });

  it("shares each boundary between two segments", () => {
    expect(state.times).toEqual([0, 10, 20, 30]);
  });

  it("tells a drift from a constant by the engine's threshold", () => {
    const edited = toSegments({ ...state, offsetEnds: [1.1, 2.3, 3.5] });
    expect(edited.map((s) => s.is_drift)).toEqual([false, true, true]);
  });
});

describe("mergeSegment", () => {
  it("lets the next segment cover a removed one", () => {
    expect(mergeSegment(state, 1)).toEqual({ times: [0, 10, 30], offsetStarts: [1, 3], offsetEnds: [1, 3.5], confidences: [0.9, 0.8] });
  });

  it("lets the previous segment cover the last one", () => {
    expect(mergeSegment(state, 2)).toEqual({ times: [0, 10, 30], offsetStarts: [1, 2], offsetEnds: [1, 2], confidences: [0.9, 0.2] });
  });
});

describe("splitSegment", () => {
  it("cuts a drift in two halves of the same line", () => {
    expect(splitSegment(state, 2, 25)).toEqual({
      times: [0, 10, 20, 25, 30],
      offsetStarts: [1, 2, 3, 3.25],
      offsetEnds: [1, 2, 3.25, 3.5],
      confidences: [0.9, 0.2, 0.8, 0.8],
    });
  });
});

describe("ignoreLowConfidenceSegments", () => {
  it("merges away every unreliable segment", () => {
    expect(ignoreLowConfidenceSegments(state)).toEqual(mergeSegment(state, 1));
  });

  it("keeps one segment when all are unreliable", () => {
    const low = toEditorState([seg(0, 10, 1, 1, 0.1), seg(10, 20, 2, 2, 0.1), seg(20, 30, 3, 3, 0.1)]);
    expect(ignoreLowConfidenceSegments(low).offsetStarts).toHaveLength(1);
  });

  it("changes nothing when all are reliable", () => {
    const reliable = toEditorState([seg(0, 10, 1, 1, 0.9)]);
    expect(sameState(ignoreLowConfidenceSegments(reliable), reliable)).toBe(true);
  });
});
