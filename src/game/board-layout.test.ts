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

  it("uses available height so an 8x8 board keeps its scoreboard visible", () => {
    const layout = calculateBoardLayout(430, 8, 8, 620, 360);
    expect(layout.width).toBe(360);
    expect(layout.height).toBe(360);
  });

  it("never imposes a minimum board size larger than the remaining viewport", () => {
    const layout = calculateBoardLayout(320, 8, 8, 620, 72);
    expect(layout.width).toBe(72);
    expect(layout.height).toBe(72);
  });

  it.each([320, 375, 430])(
    "fits the active board at %i CSS pixels without horizontal overflow",
    (viewportWidth) => {
      const horizontalPadding = 24;
      const layout = calculateBoardLayout(
        viewportWidth - horizontalPadding,
        4,
        4,
        620,
        480,
      );
      expect(layout.width).toBeLessThanOrEqual(
        viewportWidth - horizontalPadding,
      );
    },
  );
});
