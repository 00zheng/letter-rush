import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("missing-RPC recovery", () => {
  it("stops challenge polling, supports manual retry, and resets on auth change", () => {
    const hook = source("src/hooks/use-player-challenges.ts");
    const inbox = source("src/components/player-challenge-inbox.tsx");
    expect(hook).toContain('classified.kind === "missing_rpc"');
    expect(hook).toContain("pollingStoppedRef.current = true");
    expect(hook).toContain("MAXIMUM_CHALLENGE_POLL_ATTEMPTS");
    expect(hook).toContain("supabase.auth.onAuthStateChange");
    expect(inbox).toContain("Retrying…");
    expect(inbox).toContain("void refresh()");
  });

  it("stops rematch polling without disabling the rematch action", () => {
    const controls = source("src/components/rematch-controls.tsx");
    expect(controls).toContain('classified.kind === "missing_rpc"');
    expect(controls).toContain("MAXIMUM_REMATCH_POLL_ATTEMPTS");
    expect(controls).toContain("Retry status");
    expect(controls).toContain("onClick={() => void request()}");
  });

  it("keeps the last preview snapshot and offers explicit retry", () => {
    const preview = source("src/components/pregame-preview.tsx");
    expect(preview).toContain('classified.kind === "missing_rpc"');
    expect(preview).toContain("MAXIMUM_PREVIEW_POLL_ATTEMPTS");
    expect(preview).toContain("Retry preview");
    expect(preview).toContain(
      "isNewerPreviewState(candidate, current) ? candidate : current",
    );
  });

  it("uses a bounded server request and exact-board local fallback for results", () => {
    const hook = source("src/hooks/use-word-opportunities.ts");
    const solver = source("src/game/board-solver-client.ts");
    expect(hook).toContain('"get_match_word_opportunities"');
    expect(hook).toContain("boardAnalysisRegistry.request");
    expect(hook).toContain("solveBoardInWorker(solverInput");
    expect(hook).toContain("}, 2_000)");
    expect(solver).toContain("timeoutMs = 7_000");
    expect(solver).toContain("activeCells: input.activeCells");
  });
});
