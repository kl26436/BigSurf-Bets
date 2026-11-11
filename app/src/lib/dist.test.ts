import { describe, expect, it } from "vitest";
import fixture from "./dist.fixture.json";
import { fairAmerican, probOver, startLine } from "./dist";
import type { ModelDist } from "./types";

// dist.fixture.json is written by the Python model code (model/dist.py): two fitted
// shapes and the chance of going over that Python worked out for a few numbers.
describe("probOver matches the model", () => {
  const dists: Record<string, ModelDist> = {
    nb: { stat: "receptions", kind: "nb", params: fixture.nb },
    emp: { stat: "receiving_yards", kind: "emp", params: fixture.emp },
  };
  for (const [kind, mean, line, want] of fixture.cases as [string, number, number, number][]) {
    it(`${kind}: projected ${mean}, over ${line}`, () => {
      // counts are exact; yards are read off a coarser grid here than the app gets
      expect(probOver(dists[kind], mean, line)).toBeCloseTo(want, kind === "nb" ? 6 : 1);
    });
  }
  it("a higher number is never likelier", () => {
    let last = 1;
    for (let line = 0.5; line < 200; line += 5) {
      const p = probOver(dists.emp, 60, line);
      expect(p).toBeLessThanOrEqual(last + 1e-9);
      last = p;
    }
  });
});

describe("fair prices", () => {
  it("turns a chance into the break-even price", () => {
    expect(fairAmerican(0.5)).toBe(-100);
    expect(fairAmerican(0.6)).toBe(-150);
    expect(fairAmerican(0.25)).toBe(300);
    expect(fairAmerican(0)).toBeNull();
  });
  it("starts on a half", () => {
    expect(startLine(62.3)).toBe(61.5);
    expect(startLine(0.2)).toBe(0.5);
  });
});
