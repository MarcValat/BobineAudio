import { describe, expect, it } from "vitest";
import { peakRange, resamplePeaks, type FullPeaks } from "./peaks";

// Four 1 s buckets over a 4 s track.
const full: FullPeaks = { min: [-1, -0.5, -0.2, -0.8], max: [1, 0.5, 0.2, 0.8] };

describe("peakRange", () => {
  it("is the min and max of the buckets the range covers", () => {
    expect(peakRange(full, 4, 1, 3)).toEqual([-0.5, 0.5]);
    expect(peakRange(full, 0, 0, 4)).toBeNull();
  });

  it("takes the bucket a range shorter than one falls in", () => {
    expect(peakRange(full, 4, 1.5, 1.6)).toEqual([-0.5, 0.5]);
  });

  it("is null for an empty range or no peaks", () => {
    expect(peakRange(full, 4, 3, 3)).toBeNull();
    expect(peakRange({ min: [], max: [] }, 4, 0, 1)).toBeNull();
  });
});

describe("resamplePeaks", () => {
  it("merges buckets when zoomed out (min of mins, max of maxes)", () => {
    expect(resamplePeaks(full, 4, 0, 4, 2)).toEqual({ min: [-1, -0.8], max: [1, 0.8], dataStart: 0, dataEnd: 4 });
  });

  it("repeats buckets when zoomed in past their resolution", () => {
    expect(resamplePeaks(full, 4, 1, 3, 4)).toEqual({
      min: [-0.5, -0.5, -0.2, -0.2],
      max: [0.5, 0.5, 0.2, 0.2],
      dataStart: 1,
      dataEnd: 3,
    });
  });

  it("only covers the track's part of a view reaching past it", () => {
    const out = resamplePeaks(full, 4, -1, 2, 2);
    expect(out).toEqual({ min: [-1, -0.5], max: [1, 0.5], dataStart: 0, dataEnd: 2 });
  });

  it("is empty for a view past the track's end", () => {
    expect(resamplePeaks(full, 4, 5, 6, 3)).toEqual({ min: [], max: [], dataStart: 5, dataEnd: 5 });
  });
});
