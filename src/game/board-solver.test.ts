import { describe, expect, it } from "vitest";

import { createShapeMask } from "./ruleset";
import { solveBoardWords } from "./board-solver";
import type { LetterBoard } from "./types";

function filledBoard(rows: number, columns: number, letter = "A"): LetterBoard {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => letter),
  );
}

describe("deterministic board solver", () => {
  it("finds horizontal, vertical, and diagonal words without tile reuse", () => {
    const board = [
      ["C", "A", "R"],
      ["X", "A", "X"],
      ["X", "X", "T"],
    ];
    const words = solveBoardWords({
      activeCells: Array.from({ length: 9 }, () => true),
      board,
      columns: 3,
      dictionaryWords: ["car", "cat", "caaac"],
      minimumWordLength: 3,
      rows: 3,
    });
    expect(words.map((entry) => entry.word)).toEqual(["CAR", "CAT"]);
  });

  it("does not traverse inactive cells", () => {
    expect(
      solveBoardWords({
        activeCells: [true, false, true],
        board: [["C", "A", "T"]],
        columns: 3,
        dictionaryWords: ["cat"],
        minimumWordLength: 3,
        rows: 1,
      }),
    ).toEqual([]);
  });

  it.each([
    ["4x4 rectangle", 4, 4, createShapeMask(4, 4, "rectangle")],
    ["6x6 diamond", 6, 6, createShapeMask(6, 6, "diamond")],
    ["8x8 cross", 8, 8, createShapeMask(8, 8, "cross")],
    [
      "irregular custom mask",
      3,
      4,
      [
        true,
        true,
        false,
        false,
        false,
        true,
        true,
        false,
        false,
        false,
        true,
        true,
      ],
    ],
    ["10x10 rectangle", 10, 10, createShapeMask(10, 10, "rectangle")],
  ] as const)(
    "supports a %s active-cell geometry",
    (_, rows, columns, mask) => {
      expect(
        solveBoardWords({
          activeCells: mask,
          board: filledBoard(rows, columns),
          columns,
          dictionaryWords: ["zzz"],
          minimumWordLength: 3,
          rows,
        }),
      ).toEqual([]);
    },
  );

  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    "handles a %ix%i rectangle without changing the search rules",
    (size) => {
      expect(
        solveBoardWords({
          activeCells: createShapeMask(size, size, "rectangle"),
          board: filledBoard(size, size),
          columns: size,
          dictionaryWords: ["zzz"],
          minimumWordLength: 3,
          rows: size,
        }),
      ).toEqual([]);
    },
  );

  it("returns fewer than ten and an empty result naturally", () => {
    const input = {
      activeCells: [true, true, true, true],
      board: [["C", "A", "T", "S"]],
      columns: 4,
      minimumWordLength: 3,
      rows: 1,
    };
    expect(
      solveBoardWords({ ...input, dictionaryWords: ["cat", "cats"] }).map(
        (entry) => entry.word,
      ),
    ).toEqual(["CATS", "CAT"]);
    expect(solveBoardWords({ ...input, dictionaryWords: ["dog"] })).toEqual([]);
  });

  it("caps at ten with deterministic length, score, and alphabetic ordering", () => {
    const alphabet = "ABCDEFGHIJKLM";
    const dictionaryWords = Array.from({ length: 11 }, (_, index) =>
      alphabet.slice(0, index + 3),
    );
    const solve = () =>
      solveBoardWords({
        activeCells: Array.from({ length: alphabet.length }, () => true),
        board: [[...alphabet]],
        columns: alphabet.length,
        dictionaryWords,
        minimumWordLength: 3,
        rows: 1,
      });
    expect(solve()).toHaveLength(10);
    expect(solve()).toEqual(solve());
    expect(solve()[0].word).toBe(alphabet);
  });
});
