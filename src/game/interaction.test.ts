import { describe, expect, it } from "vitest";

import {
  ACCEPTED_WORD_NOTICE_MS,
  DUPLICATE_WORD_NOTICE_MS,
  TERMINAL_SELECTION_FLASH_MS,
  acquireDirectionalTileCoordinates,
  advanceTilePath,
  cancelTilePath,
  crossedTileCoordinates,
  deriveLiveSelectionFeedback,
  interpolatePointerSegment,
  wordNoticeDuration,
} from "./interaction";

describe("pointer path interaction", () => {
  function gridTiles(size: number, pitch = 50, tileSize = 40) {
    return Array.from({ length: size * size }, (_, index) => {
      const row = Math.floor(index / size);
      const column = index % size;
      const left = column * pitch;
      const top = row * pitch;
      return {
        coordinate: { row, column },
        left,
        right: left + tileSize,
        top,
        bottom: top + tileSize,
        centerX: left + tileSize / 2,
        centerY: top + tileSize / 2,
      };
    });
  }

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
      centerX: column * 50 + 20,
      centerY: 20,
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
            centerX: 20,
            centerY: 20,
          },
        ],
      ),
    ).toEqual([]);
  });

  it.each([
    ["northwest", { row: 0, column: 0 }],
    ["north", { row: 0, column: 1 }],
    ["northeast", { row: 0, column: 2 }],
    ["west", { row: 1, column: 0 }],
    ["east", { row: 1, column: 2 }],
    ["southwest", { row: 2, column: 0 }],
    ["south", { row: 2, column: 1 }],
    ["southeast", { row: 2, column: 2 }],
  ] as const)("acquires the %s neighbor symmetrically", (_, target) => {
    const tiles = gridTiles(3);
    const tile = tiles.find(
      ({ coordinate }) =>
        coordinate.row === target.row && coordinate.column === target.column,
    )!;
    expect(
      acquireDirectionalTileCoordinates(
        { clientX: tile.centerX, clientY: tile.centerY },
        [{ row: 1, column: 1 }],
        tiles,
      ),
    ).toEqual([target]);
  });

  it("acquires a diagonal through the gap without snapping horizontally", () => {
    expect(
      acquireDirectionalTileCoordinates(
        { clientX: 50, clientY: 50 },
        [{ row: 0, column: 0 }],
        gridTiles(3),
      ),
    ).toEqual([{ row: 1, column: 1 }]);
  });

  it("keeps clearly horizontal motion on the horizontal neighbor", () => {
    expect(
      acquireDirectionalTileCoordinates(
        { clientX: 80, clientY: 20 },
        [{ row: 0, column: 0 }],
        gridTiles(3),
      ),
    ).toEqual([{ row: 0, column: 1 }]);
  });

  it("processes legitimate adjacent tiles during a fast 10x10 swipe", () => {
    expect(
      acquireDirectionalTileCoordinates(
        { clientX: 470, clientY: 20 },
        [{ row: 0, column: 0 }],
        gridTiles(10),
      ),
    ).toEqual(
      Array.from({ length: 9 }, (_, index) => ({
        row: 0,
        column: index + 1,
      })),
    );
  });

  it("never selects nonadjacent or already-used tiles", () => {
    const tiles = gridTiles(4);
    expect(
      acquireDirectionalTileCoordinates(
        { clientX: 170, clientY: 170 },
        [
          { row: 0, column: 0 },
          { row: 1, column: 1 },
          { row: 0, column: 1 },
        ],
        tiles,
      )[0],
    ).not.toEqual({ row: 0, column: 0 });
    expect(
      advanceTilePath([{ row: 0, column: 0 }], { row: 3, column: 3 }),
    ).toEqual([{ row: 0, column: 0 }]);
  });

  it("keeps terminal path feedback visible and uses bounded notices", () => {
    expect(TERMINAL_SELECTION_FLASH_MS).toBeGreaterThanOrEqual(70);
    expect(TERMINAL_SELECTION_FLASH_MS).toBeLessThanOrEqual(120);
    expect(wordNoticeDuration("accepted")).toBe(ACCEPTED_WORD_NOTICE_MS);
    expect(wordNoticeDuration("duplicate")).toBe(DUPLICATE_WORD_NOTICE_MS);
  });
});
