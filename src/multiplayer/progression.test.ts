import { describe, expect, it } from "vitest";

import {
  deriveRerollConsensus,
  resolveRematchProposal,
  sortValidatedWords,
} from "./progression";

describe("pregame rerolls", () => {
  it("requires every participant and allows three completed rerolls", () => {
    expect(
      deriveRerollConsensus({
        participantCount: 3,
        approvals: 2,
        completedRerolls: 0,
        previewOpen: true,
      }),
    ).toBe("open");
    expect(
      deriveRerollConsensus({
        participantCount: 3,
        approvals: 3,
        completedRerolls: 2,
        previewOpen: true,
      }),
    ).toBe("unanimous");
    expect(
      deriveRerollConsensus({
        participantCount: 3,
        approvals: 3,
        completedRerolls: 3,
        previewOpen: true,
      }),
    ).toBe("closed");
  });

  it("keeps the original board after a preview timeout", () => {
    expect(
      deriveRerollConsensus({
        participantCount: 2,
        approvals: 2,
        completedRerolls: 0,
        previewOpen: false,
      }),
    ).toBe("closed");
  });
});

describe("rematch proposals", () => {
  it("accepts or declines only while pending and unexpired", () => {
    expect(
      resolveRematchProposal({
        state: "pending",
        databaseNowMs: 29_999,
        expiresAtMs: 30_000,
        response: "accept",
      }),
    ).toBe("accepted");
    expect(
      resolveRematchProposal({
        state: "pending",
        databaseNowMs: 30_000,
        expiresAtMs: 30_000,
        response: "accept",
      }),
    ).toBe("expired");
    expect(
      resolveRematchProposal({
        state: "accepted",
        databaseNowMs: 1,
        expiresAtMs: 30_000,
        response: "decline",
      }),
    ).toBe("accepted");
  });
});

describe("validated word ordering", () => {
  it("sorts by points, then length, then alphabetically", () => {
    expect(
      sortValidatedWords([
        { word: "RATE", score: 400 },
        { word: "CART", score: 400 },
        { word: "MASTER", score: 1_400 },
        { word: "CAT", score: 100 },
      ]).map((entry) => entry.word),
    ).toEqual(["MASTER", "CART", "RATE", "CAT"]);
  });
});
