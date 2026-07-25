import { describe, expect, it } from "vitest";

import {
  ACCEPTED_WORD_NOTICE_MS,
  DUPLICATE_WORD_NOTICE_MS,
  TERMINAL_SELECTION_FLASH_MS,
  advanceTilePath,
  cancelTilePath,
  crossedTileCoordinates,
  deriveLiveSelectionFeedback,
  interpolatePointerSegment,
  wordNoticeDuration,
} from "./interaction";

describe("pointer path interaction", () => {
  it("adds adjacent unused tiles without allowing backtracking or reuse", () => {
    const first = advanceTilePath([], { row: 0, column: 0 });
    const second = advanceTilePath(first, { row: 1, column: 1 });
    const third = advanceTilePath(second, { row: 1, column: 2 });
    expect(third).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
    expect(advanceTilePath(third, { row: 1, column: 1 })).toEqual(third);
    expect(advanceTilePath(third, { row: 0, column: 0 })).toEqual(third);
    expect(advanceTilePath(third, { row: 2, column: 2 })).toEqual([
      ...third,
      { row: 2, column: 2 },
    ]);
  });

  it("ignores repeated pointer entries and nonadjacent tiles", () => {
    const path = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
    ];
    expect(advanceTilePath(path, { row: 0, column: 2 })).toEqual(path);
    expect(advanceTilePath(path, { row: 2, column: 2 })).toEqual(path);
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

  it("samples fast pointer segments densely enough to cross intermediate tiles", () => {
    expect(
      interpolatePointerSegment(
        { clientX: 0, clientY: 0 },
        { clientX: 120, clientY: 0 },
        40,
      ),
    ).toEqual([
      { clientX: 40, clientY: 0 },
      { clientX: 80, clientY: 0 },
      { clientX: 120, clientY: 0 },
    ]);
  });

  it("finds every cached tile crossed by a fast pointer segment in travel order", () => {
    const tiles = [0, 1, 2].map((column) => ({
      coordinate: { row: 0, column },
      left: column * 50,
      right: column * 50 + 40,
      top: 0,
      bottom: 40,
    }));

    expect(
      crossedTileCoordinates(
        { clientX: 20, clientY: 20 },
        { clientX: 120, clientY: 20 },
        tiles,
      ),
    ).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
    ]);
  });

  it("does not report tiles outside the pointer segment", () => {
    expect(
      crossedTileCoordinates(
        { clientX: 0, clientY: 60 },
        { clientX: 120, clientY: 60 },
        [
          {
            coordinate: { row: 0, column: 0 },
            left: 0,
            right: 40,
            top: 0,
            bottom: 40,
          },
        ],
      ),
    ).toEqual([]);
  });

  it("keeps terminal path feedback visible and uses bounded notices", () => {
    expect(TERMINAL_SELECTION_FLASH_MS).toBeGreaterThanOrEqual(70);
    expect(TERMINAL_SELECTION_FLASH_MS).toBeLessThanOrEqual(120);
    expect(wordNoticeDuration("accepted")).toBe(ACCEPTED_WORD_NOTICE_MS);
    expect(wordNoticeDuration("duplicate")).toBe(DUPLICATE_WORD_NOTICE_MS);
  });
});
