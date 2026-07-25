import { describe, expect, it } from "vitest";

import { DEFAULT_BOARD, generateBoard, generateBoardFromSeed } from "./board";
import { createRuleset, LEGACY_RULESET } from "./ruleset";

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

describe("versioned generalized boards", () => {
  it("preserves legacy boards for existing matches", () => {
    expect(generateBoard(1, LEGACY_RULESET)).toEqual(generateBoardFromSeed(1));
  });

  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    "generates a stable playable %i-square fixture",
    (size) => {
      const ruleset = createRuleset(size, size);
      const first = generateBoard(20260724, ruleset);
      const second = generateBoard(20260724, ruleset);

      expect(first).toEqual(second);
      expect(first).toHaveLength(size);
      expect(first.flat().filter(Boolean)).toHaveLength(size * size);
      expect(
        first.flat().filter((letter) => /[AEIOU]/.test(letter ?? "")).length,
      ).toBeGreaterThanOrEqual(Math.ceil(size * size * 0.28));
      expect(
        first
          .flat()
          .map((letter) => letter ?? "-")
          .join(""),
      ).toMatchSnapshot();
    },
  );

  it("leaves shape-mask cells empty without shifting coordinates", () => {
    const ruleset = createRuleset(5, 5, "cross");
    const board = generateBoard(42, ruleset);

    expect(board[0][0]).toBeNull();
    expect(board[0][2]).toMatch(/^[A-Z]$/);
    expect(board[2][0]).toMatch(/^[A-Z]$/);
  });
});
