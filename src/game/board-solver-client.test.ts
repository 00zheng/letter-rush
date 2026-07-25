import { describe, expect, it } from "vitest";

import { DEFAULT_RULESET } from "./ruleset";
import {
  createBoardSolverCacheKey,
  parseBoardSolverCacheKey,
} from "./board-solver-client";
import type { LetterBoard } from "./types";

const board: LetterBoard = [
  ["C", "A", "T", "S"],
  ["A", "R", "E", "D"],
  ["T", "E", "S", "T"],
  ["S", "D", "T", "A"],
];

describe("board solver analysis key", () => {
  it("is stable across equivalent board and ruleset object identities", () => {
    const first = createBoardSolverCacheKey(board, DEFAULT_RULESET);
    const second = createBoardSolverCacheKey(
      board.map((row) => [...row]),
      { ...DEFAULT_RULESET, activeCells: [...DEFAULT_RULESET.activeCells] },
    );
    expect(second).toBe(first);
  });

  it("includes dimensions, normalized mask, dictionary, scoring, and minimum length", () => {
    expect(
      parseBoardSolverCacheKey(
        createBoardSolverCacheKey(board, DEFAULT_RULESET),
      ),
    ).toEqual({
      activeCells: Array.from({ length: 16 }, () => true),
      board,
      columns: 4,
      dictionaryVersion: DEFAULT_RULESET.dictionaryVersion,
      minimumWordLength: DEFAULT_RULESET.minimumWordLength,
      rows: 4,
      scoringRulesVersion: DEFAULT_RULESET.scoringRulesVersion,
    });
  });

  it("changes when the board or active-cell identity changes", () => {
    const first = createBoardSolverCacheKey(board, DEFAULT_RULESET);
    const changedBoard = board.map((row) => [...row]);
    changedBoard[0][0] = "D";
    const changedMask = {
      ...DEFAULT_RULESET,
      activeCells: DEFAULT_RULESET.activeCells.map((active, index) =>
        index === 0 ? false : active,
      ),
    };
    expect(createBoardSolverCacheKey(changedBoard, DEFAULT_RULESET)).not.toBe(
      first,
    );
    expect(createBoardSolverCacheKey(board, changedMask)).not.toBe(first);
  });
});
