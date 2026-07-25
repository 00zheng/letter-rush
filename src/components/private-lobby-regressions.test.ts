import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const gameApp = readFileSync(
  resolve(process.cwd(), "src/components/game-app.tsx"),
  "utf8",
);

describe("private lobby request lifecycle", () => {
  it("wires creation through one bounded single-flight request", () => {
    expect(gameApp.match(/\.rpc\("create_private_lobby"/gu)).toHaveLength(1);
    expect(gameApp).toContain("privateLobbyRequestGate.start");
    expect(gameApp).toContain("privateLobbyRequestGate.isPending");
    expect(gameApp).toContain(".abortSignal(signal)");
    expect(gameApp).toContain("8_000");
  });

  it("disables creation while pending and restores state in finally", () => {
    expect(gameApp).toContain(
      "isWorking || !isOnline || lobbyConfiguration.maxPlayers < 2",
    );
    expect(gameApp).toContain('isWorking ? "Creating..."');
    expect(gameApp).toMatch(
      /finally \{[\s\S]*privateLobbyRequestGate\.isLatest\(generationId\)[\s\S]*setIsWorking\(false\)/u,
    );
  });

  it("ignores obsolete generations and cancels work on unmount", () => {
    expect(gameApp).toContain(
      "if (!privateLobbyRequestGate.isLatest(generationId)) return",
    );
    expect(gameApp).toContain("privateLobbyRequestGate.cancel()");
  });

  it("uses structured errors rather than broad cancellation substrings", () => {
    expect(gameApp).toContain("privateLobbyErrorMessage");
    expect(gameApp).toContain("classifySupabaseError(error)");
    expect(gameApp).not.toMatch(/includes\(["']cancel/iu);
  });
});
