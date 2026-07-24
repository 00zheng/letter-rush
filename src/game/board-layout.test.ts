import { describe, expect, it } from "vitest";

import { calculateBoardLayout } from "./board-layout";

describe("responsive board layout", () => {
  it.each([4, 5, 6, 8])("fits a %ix%i board at 320 CSS pixels", (size) => {
    const layout = calculateBoardLayout(288, size, size);
    expect(layout.width).toBe(288);
    expect(layout.height).toBe(288);
    expect(layout.tileFontSize).toBeGreaterThanOrEqual(14);
    expect(layout.gap).toBeGreaterThanOrEqual(2);
  });

  it("keeps rectangular boards proportional and caps desktop width", () => {
    expect(calculateBoardLayout(1_200, 3, 8)).toMatchObject({
      width: 620,
      height: 232.5,
    });
    expect(calculateBoardLayout(300, 8, 4).height).toBe(600);
  });
});
