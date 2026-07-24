import { describe, expect, it } from "vitest";

import {
  advanceTilePath,
  cancelTilePath,
  deriveLiveSelectionFeedback,
} from "./interaction";

describe("pointer path interaction", () => {
  it("adds neighbors, backtracks one tile, and ignores repeats", () => {
    const first = advanceTilePath([], { row: 0, column: 0 });
    const second = advanceTilePath(first, { row: 1, column: 1 });
    expect(second).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 1 },
    ]);
    expect(advanceTilePath(second, { row: 0, column: 0 })).toEqual(first);
    expect(
      advanceTilePath([...second, { row: 1, column: 2 }], {
        row: 0,
        column: 0,
      }),
    ).toHaveLength(3);
  });

  it("clears selection after touch cancellation, lost focus, or capture loss", () => {
    expect(cancelTilePath()).toEqual([]);
  });

  it.each([
    [2, false, false, "neutral", "Keep building"],
    [4, false, false, "neutral", "Not in dictionary"],
    [4, true, false, "valid", "Valid word"],
    [4, true, true, "duplicate", "Already found"],
  ] as const)(
    "derives live tile and text feedback for a %i-letter selection",
    (wordLength, isDictionaryWord, isDuplicate, tileState, message) => {
      expect(
        deriveLiveSelectionFeedback({
          wordLength,
          minimumWordLength: 3,
          isDictionaryWord,
          isDuplicate,
        }),
      ).toEqual({ tileState, message });
    },
  );
});
