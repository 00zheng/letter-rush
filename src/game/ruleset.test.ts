import { describe, expect, it } from "vitest";

import {
  areActiveCellsConnected,
  createRuleset,
  createShapeMask,
  DEFAULT_RULESET,
  validateRuleset,
} from "./ruleset";

describe("rulesets", () => {
  it("normalizes supported rectangular presets", () => {
    for (const size of [4, 5, 6, 8]) {
      const ruleset = createRuleset(size, size);
      expect(validateRuleset(ruleset)).toEqual({
        isValid: true,
        ruleset,
      });
    }
  });

  it("creates connected rectangle, diamond, and cross masks", () => {
    for (const shape of ["rectangle", "diamond", "cross"] as const) {
      const geometry = {
        rows: 6,
        columns: 5,
        activeCells: createShapeMask(6, 5, shape),
      };
      expect(areActiveCellsConnected(geometry)).toBe(true);
      expect(
        geometry.activeCells.filter(Boolean).length,
      ).toBeGreaterThanOrEqual(9);
    }
  });

  it("rejects disconnected and undersized custom shapes", () => {
    expect(
      validateRuleset({
        ...DEFAULT_RULESET,
        shape: "custom",
        activeCells: Array.from({ length: 16 }, (_, index) =>
          [0, 1, 2, 4, 5, 6, 8, 9, 15].includes(index),
        ),
      }),
    ).toMatchObject({
      isValid: false,
      message: "All active cells must form one connected shape.",
    });

    expect(
      validateRuleset({
        ...DEFAULT_RULESET,
        shape: "custom",
        activeCells: Array.from({ length: 16 }, (_, index) => index < 8),
      }),
    ).toMatchObject({ isValid: false });
  });

  it("rejects unsupported dimensions, durations, and versions", () => {
    expect(validateRuleset({ ...DEFAULT_RULESET, rows: 9 })).toMatchObject({
      isValid: false,
    });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, roundDurationSeconds: 45 }),
    ).toMatchObject({ isValid: false });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, dictionaryVersion: "future" }),
    ).toMatchObject({ isValid: false });
  });
});
