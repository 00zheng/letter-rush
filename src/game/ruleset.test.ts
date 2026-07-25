import { describe, expect, it } from "vitest";

import {
  areActiveCellsConnected,
  createRuleset,
  createShapeMask,
  DEFAULT_RULESET,
  serializeRuleset,
  validateRuleset,
} from "./ruleset";

describe("rulesets", () => {
  it("normalizes supported rectangular presets", () => {
    for (const size of [3, 4, 5, 6, 7, 8, 9, 10]) {
      const ruleset = createRuleset(size, size);
      expect(validateRuleset(ruleset)).toEqual({
        isValid: true,
        ruleset,
      });
    }
  });

  it("scales diamond and cross masks with board dimensions", () => {
    for (const shape of ["diamond", "cross"] as const) {
      const four = createShapeMask(4, 4, shape);
      const eight = createShapeMask(8, 8, shape);
      expect(eight.filter(Boolean).length).toBeGreaterThan(
        four.filter(Boolean).length,
      );
      expect(
        areActiveCellsConnected({
          rows: 8,
          columns: 8,
          activeCells: eight,
        }),
      ).toBe(true);
    }
  });

  it("keeps generated shapes symmetric, connected, and playable from 3 to 10", () => {
    for (const shape of ["diamond", "cross"] as const) {
      for (let rows = 3; rows <= 10; rows += 1) {
        for (let columns = 3; columns <= 10; columns += 1) {
          const activeCells = createShapeMask(rows, columns, shape);
          expect(activeCells.filter(Boolean).length).toBeGreaterThanOrEqual(9);
          expect(areActiveCellsConnected({ rows, columns, activeCells })).toBe(
            true,
          );

          for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
              const value = activeCells[row * columns + column];
              expect(value).toBe(
                activeCells[row * columns + (columns - 1 - column)],
              );
              expect(value).toBe(
                activeCells[(rows - 1 - row) * columns + column],
              );
            }
          }
        }
      }
    }
  });

  it("makes even diamonds widen to the board before narrowing symmetrically", () => {
    for (const size of [4, 6, 8, 10]) {
      const mask = createShapeMask(size, size, "diamond");
      const rowCounts = Array.from(
        { length: size },
        (_, row) =>
          mask.slice(row * size, (row + 1) * size).filter(Boolean).length,
      );

      expect(rowCounts[size / 2 - 1]).toBe(size);
      expect(rowCounts[size / 2]).toBe(size);
      expect(rowCounts).toEqual([...rowCounts].reverse());
      for (let row = 1; row < size / 2; row += 1) {
        expect(rowCounts[row]).toBeGreaterThanOrEqual(rowCounts[row - 1]);
      }
    }
  });

  it("accepts non-square custom rectangles with an exact connected mask", () => {
    const activeCells = createShapeMask(5, 7, "rectangle").map(
      (active, index) => active && index !== 0,
    );
    expect(
      validateRuleset({
        ...DEFAULT_RULESET,
        rows: 5,
        columns: 7,
        shape: "custom",
        activeCells,
      }),
    ).toMatchObject({ isValid: true });
  });

  it("uses the same diagonal adjacency rule as word paths", () => {
    expect(
      areActiveCellsConnected({
        rows: 3,
        columns: 3,
        activeCells: [
          true,
          false,
          false,
          false,
          true,
          false,
          false,
          false,
          true,
        ],
      }),
    ).toBe(true);
  });

  it("serializes and restores a 10 by 10 custom mask exactly", () => {
    const activeCells = Array.from({ length: 100 }, (_, index) => index !== 44);
    const custom = validateRuleset({
      ...createRuleset(10, 10),
      shape: "custom",
      activeCells,
    });
    expect(custom.isValid).toBe(true);
    if (!custom.isValid) return;

    expect(
      validateRuleset(JSON.parse(serializeRuleset(custom.ruleset))),
    ).toEqual(custom);
    expect(custom.ruleset.activeCells[0]).toBe(true);
    expect(custom.ruleset.activeCells[99]).toBe(true);
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

  it("accepts whole-number custom durations from 10 through 180 seconds", () => {
    for (const roundDurationSeconds of [10, 45, 60, 179, 180]) {
      expect(
        validateRuleset({ ...DEFAULT_RULESET, roundDurationSeconds }),
      ).toMatchObject({ isValid: true });
    }
  });

  it("rejects unsupported dimensions, durations, and versions", () => {
    expect(validateRuleset({ ...DEFAULT_RULESET, rows: 11 })).toMatchObject({
      isValid: false,
    });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, roundDurationSeconds: 9 }),
    ).toMatchObject({ isValid: false });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, roundDurationSeconds: 181 }),
    ).toMatchObject({ isValid: false });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, roundDurationSeconds: 10.5 }),
    ).toMatchObject({ isValid: false });
    expect(
      validateRuleset({ ...DEFAULT_RULESET, dictionaryVersion: "future" }),
    ).toMatchObject({ isValid: false });
  });
});
