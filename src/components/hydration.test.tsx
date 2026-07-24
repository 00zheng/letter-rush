import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GameApp } from "./game-app";

describe("deterministic initial rendering", () => {
  it("renders the same server/client bootstrap markup without time or randomness", () => {
    expect(renderToString(<GameApp />)).toBe(renderToString(<GameApp />));
  });
});
