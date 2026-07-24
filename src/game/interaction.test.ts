import { describe, expect, it } from "vitest";

import { advanceTilePath, cancelTilePath } from "./interaction";

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
});
