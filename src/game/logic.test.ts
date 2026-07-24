import { describe, expect, it } from "vitest";

import {
  areCoordinatesAdjacent,
  calculateWordScore,
  createWordFromPath,
  hasRepeatedTiles,
  isDuplicateWord,
  validateTilePath,
} from "./logic";

const BOARD = [
  ["C", "A", "T", "S"],
  ["R", "E", "A", "M"],
  ["T", "I", "L", "E"],
  ["S", "O", "N", "G"],
] as const;

describe("areCoordinatesAdjacent", () => {
  it("accepts horizontal, vertical, and diagonal neighbors", () => {
    const origin = { row: 1, column: 1 };

    expect(areCoordinatesAdjacent(origin, { row: 1, column: 2 })).toBe(true);
    expect(areCoordinatesAdjacent(origin, { row: 2, column: 1 })).toBe(true);
    expect(areCoordinatesAdjacent(origin, { row: 2, column: 2 })).toBe(true);
  });

  it("rejects the same tile and distant tiles", () => {
    expect(
      areCoordinatesAdjacent({ row: 1, column: 1 }, { row: 1, column: 1 }),
    ).toBe(false);
    expect(
      areCoordinatesAdjacent({ row: 0, column: 0 }, { row: 0, column: 2 }),
    ).toBe(false);
  });
});

describe("hasRepeatedTiles", () => {
  it("detects a coordinate used more than once", () => {
    expect(
      hasRepeatedTiles([
        { row: 0, column: 0 },
        { row: 1, column: 1 },
        { row: 0, column: 0 },
      ]),
    ).toBe(true);
  });

  it("accepts a path of unique coordinates", () => {
    expect(
      hasRepeatedTiles([
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 1, column: 1 },
      ]),
    ).toBe(false);
  });
});

describe("validateTilePath", () => {
  it("accepts a complete adjacent path with no repeated tiles", () => {
    expect(
      validateTilePath([
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 1, column: 1 },
        { row: 2, column: 2 },
      ]),
    ).toEqual({ isValid: true });
  });

  it.each([
    [[], "empty-path"],
    [[{ row: 4, column: 0 }], "out-of-bounds"],
    [
      [
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 0, column: 0 },
      ],
      "repeated-tile",
    ],
    [
      [
        { row: 0, column: 0 },
        { row: 2, column: 2 },
      ],
      "non-adjacent-tiles",
    ],
  ] as const)("rejects an invalid path with reason %s", (path, reason) => {
    expect(validateTilePath(path)).toEqual({ isValid: false, reason });
  });

  it("rejects an inactive tile", () => {
    expect(
      validateTilePath([{ row: 1, column: 1 }], {
        rows: 3,
        columns: 3,
        activeCells: [true, true, true, true, false, true, true, true, true],
      }),
    ).toEqual({ isValid: false, reason: "inactive-tile" });
  });

  it("supports rectangular boards without allowing inactive cells", () => {
    const geometry = {
      rows: 3,
      columns: 5,
      activeCells: Array.from({ length: 15 }, (_, index) => index !== 7),
    };

    expect(
      validateTilePath(
        [
          { row: 0, column: 3 },
          { row: 0, column: 4 },
          { row: 1, column: 4 },
        ],
        geometry,
      ),
    ).toEqual({ isValid: true });
    expect(validateTilePath([{ row: 1, column: 2 }], geometry)).toEqual({
      isValid: false,
      reason: "inactive-tile",
    });
  });
});

describe("createWordFromPath", () => {
  it("creates a word in path order", () => {
    expect(
      createWordFromPath(BOARD, [
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 0, column: 2 },
      ]),
    ).toBe("CAT");
  });

  it("throws when a path coordinate is outside the board", () => {
    expect(() => createWordFromPath(BOARD, [{ row: 9, column: 9 }])).toThrow(
      RangeError,
    );
  });
});

describe("calculateWordScore", () => {
  it.each([
    ["AT", 0],
    ["CAT", 100],
    ["CARE", 400],
    ["STONE", 800],
    ["STREAM", 1_400],
    ["REALIST", 1_800],
    ["RELATION", 2_200],
    ["MASTERING", 2_200],
  ])("scores %s as %i", (word, expectedScore) => {
    expect(calculateWordScore(word)).toBe(expectedScore);
  });
});

describe("isDuplicateWord", () => {
  it("detects duplicates without case or surrounding-space sensitivity", () => {
    expect(isDuplicateWord(" care ", ["CAT", "CARE"])).toBe(true);
  });

  it("allows a word that has not been submitted", () => {
    expect(isDuplicateWord("CART", new Set(["CAT", "CARE"]))).toBe(false);
  });
});
