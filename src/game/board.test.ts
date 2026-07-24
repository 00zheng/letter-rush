import { describe, expect, it } from "vitest";

import { DEFAULT_BOARD, generateBoardFromSeed } from "./board";

describe("generateBoardFromSeed", () => {
  it("always creates the same board for the same seed", () => {
    expect(generateBoardFromSeed(42)).toEqual(generateBoardFromSeed(42));
  });

  it("uses a stable cross-browser transform for a known seed", () => {
    expect(generateBoardFromSeed(1)).toEqual([
      ["S", "T", "R", "C"],
      ["O", "I", "E", "A"],
      ["N", "L", "A", "T"],
      ["G", "E", "M", "S"],
    ]);
  });

  it("can produce a different orientation without changing the letters", () => {
    const seededBoard = generateBoardFromSeed(999);

    expect(seededBoard).not.toEqual(DEFAULT_BOARD);
    expect(seededBoard.flat().sort()).toEqual(
      DEFAULT_BOARD.flat().slice().sort(),
    );
  });
});
