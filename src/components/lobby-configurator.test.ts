import { describe, expect, it } from "vitest";

import { normalizeDimensionInput } from "./lobby-configurator";

describe("custom dimension commits", () => {
  it.each([
    ["1", 4, 3],
    ["-1", 4, 3],
    ["0", 4, 3],
    ["12", 4, 10],
    ["05", 4, 5],
    ["8", 4, 8],
    ["", 6, 6],
    ["not-a-number", 7, 7],
  ])("normalizes %s only when committed", (draft, fallback, expected) => {
    expect(normalizeDimensionInput(draft, fallback)).toBe(expected);
  });
});
