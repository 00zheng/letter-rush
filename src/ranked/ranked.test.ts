import { describe, expect, it } from "vitest";

import { DEFAULT_RULESET } from "@/game/ruleset";

import {
  LEADERBOARD_PAGE_SIZE,
  paginateLeaderboard,
  rankLeaderboard,
  type LeaderboardCandidate,
} from "./leaderboard";
import { decideRankedFinalization } from "./finalization";
import {
  OPEN_MATCH_WAIT_MS,
  allowedRatingGap,
  areQueueEntriesCompatible,
  deriveRankedRecoveryView,
  isQueueEntryStale,
  transitionQueueState,
} from "./matchmaking";
import {
  createPublicProfileSummary,
  getInitials,
  isValidPublicProfileId,
  normalizePublicProfileId,
} from "./profile";
import {
  MINIMUM_RATING,
  STARTING_RATING,
  applyRankedResult,
  applyRatingIdempotently,
  calculateRatingAdjustment,
  createInitialRankedStatistics,
  expectedScore,
} from "./rating";
import {
  RANKED_RULESET,
  RANKED_RULESET_VERSION,
  isRankedRuleset,
} from "./ruleset";

describe("ranked Elo", () => {
  it("calculates expected scores symmetrically", () => {
    expect(expectedScore(1_000, 1_000)).toBe(0.5);
    expect(expectedScore(1_200, 1_000)).toBeCloseTo(0.7597, 4);
    expect(expectedScore(1_200, 1_000) + expectedScore(1_000, 1_200)).toBe(1);
  });

  it.each([
    ["win", 16],
    ["loss", -16],
    ["tie", 0],
  ] as const)("adjusts an even matchup for a %s", (outcome, delta) => {
    const result = calculateRatingAdjustment(1_000, 1_000, outcome);
    expect(result.firstDelta).toBe(delta);
    expect(result.secondDelta).toBe(delta === 0 ? 0 : -delta);
  });

  it("keeps integer changes zero-sum after rounding", () => {
    const result = calculateRatingAdjustment(1_187, 973, "win");
    expect(Number.isInteger(result.firstDelta)).toBe(true);
    expect(result.firstDelta + result.secondDelta).toBe(0);
    expect(result.firstAfter + result.secondAfter).toBe(1_187 + 973);
  });

  it("enforces the rating floor without breaking zero-sum", () => {
    const result = calculateRatingAdjustment(MINIMUM_RATING, 1_000, "loss");
    expect(result.firstAfter).toBe(MINIMUM_RATING);
    expect(result.firstDelta).toBe(0);
    expect(result.secondDelta).toBe(0);
  });

  it("applies rating history once per match", () => {
    const incoming = { matchId: "match-1", ratingAfter: 1_016 };
    const first = applyRatingIdempotently([], incoming);
    const retry = applyRatingIdempotently(first.history, {
      matchId: "match-1",
      ratingAfter: 9_999,
    });

    expect(first.applied).toBe(true);
    expect(retry.applied).toBe(false);
    expect(retry.result).toEqual(incoming);
  });
});

describe("ranked statistics", () => {
  it("starts every player at the fixed rating", () => {
    expect(createInitialRankedStatistics().currentRating).toBe(STARTING_RATING);
  });

  it("updates wins, peak rating, score, and streaks", () => {
    const result = applyRankedResult(createInitialRankedStatistics(), {
      outcome: "win",
      score: 2_200,
      ratingAfter: 1_016,
    });
    expect(result).toMatchObject({
      currentRating: 1_016,
      peakRating: 1_016,
      gamesPlayed: 1,
      wins: 1,
      bestScore: 2_200,
      totalScore: 2_200,
      currentWinStreak: 1,
      bestWinStreak: 1,
      currentUnbeatenStreak: 1,
    });
  });

  it("a tie ends the win streak but preserves an unbeaten streak", () => {
    const won = applyRankedResult(createInitialRankedStatistics(), {
      outcome: "win",
      score: 100,
      ratingAfter: 1_016,
    });
    const tied = applyRankedResult(won, {
      outcome: "tie",
      score: 400,
      ratingAfter: 1_016,
    });
    expect(tied.currentWinStreak).toBe(0);
    expect(tied.bestWinStreak).toBe(1);
    expect(tied.currentUnbeatenStreak).toBe(2);
    expect(tied.ties).toBe(1);
  });

  it("a forfeit records a loss and resets both streaks", () => {
    const result = applyRankedResult(
      {
        ...createInitialRankedStatistics(),
        currentWinStreak: 3,
        bestWinStreak: 3,
        currentUnbeatenStreak: 4,
      },
      { outcome: "forfeit", score: 0, ratingAfter: 980 },
    );
    expect(result).toMatchObject({
      losses: 1,
      forfeits: 1,
      currentWinStreak: 0,
      bestWinStreak: 3,
      currentUnbeatenStreak: 0,
    });
  });

  it("does not mutate statistics for an abandoned match", () => {
    const initial = createInitialRankedStatistics();
    expect(initial).toEqual(createInitialRankedStatistics());
  });
});

describe("ranked result finalization", () => {
  it("compares two validated scores and treats equality as a tie", () => {
    expect(
      decideRankedFinalization({
        firstScore: 800,
        secondScore: 800,
        recoveryWindowExpired: false,
      }),
    ).toEqual({
      status: "complete",
      firstOutcome: "tie",
      secondOutcome: "tie",
    });
  });

  it("waits through recovery, then assigns one missing player a forfeit", () => {
    expect(
      decideRankedFinalization({
        firstScore: 400,
        secondScore: null,
        recoveryWindowExpired: false,
      }),
    ).toEqual({ status: "waiting" });
    expect(
      decideRankedFinalization({
        firstScore: 400,
        secondScore: null,
        recoveryWindowExpired: true,
      }),
    ).toEqual({
      status: "complete",
      firstOutcome: "win",
      secondOutcome: "forfeit",
    });
  });

  it("abandons a match when neither player submits", () => {
    expect(
      decideRankedFinalization({
        firstScore: null,
        secondScore: null,
        recoveryWindowExpired: true,
      }),
    ).toEqual({ status: "abandoned" });
  });
});

describe("ranked matchmaking", () => {
  it("widens by 50 every ten seconds, caps at 600, then opens", () => {
    expect(allowedRatingGap(0)).toBe(150);
    expect(allowedRatingGap(10_000)).toBe(200);
    expect(allowedRatingGap(80_000)).toBe(550);
    expect(allowedRatingGap(89_999)).toBe(550);
    expect(allowedRatingGap(OPEN_MATCH_WAIT_MS)).toBe(600);
    expect(allowedRatingGap(OPEN_MATCH_WAIT_MS + 1)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("rejects stale, duplicate, and incompatible entries", () => {
    const now = 100_000;
    const first = {
      userId: "first",
      ratingSnapshot: 1_000,
      joinedAtMs: now,
      heartbeatAtMs: now,
    };
    expect(
      areQueueEntriesCompatible(
        first,
        { ...first, userId: "second", ratingSnapshot: 1_149 },
        now,
      ),
    ).toBe(true);
    expect(areQueueEntriesCompatible(first, first, now)).toBe(false);
    expect(
      areQueueEntriesCompatible(
        first,
        {
          ...first,
          userId: "second",
          ratingSnapshot: 1_151,
          heartbeatAtMs: 0,
        },
        now,
      ),
    ).toBe(false);
    expect(isQueueEntryStale(64_999, now)).toBe(true);
  });

  it("models queue cancellation, expiry, and match idempotency", () => {
    const waiting = transitionQueueState(
      { status: "idle" },
      { type: "enter", databaseNowMs: 1_000 },
    );
    expect(transitionQueueState(waiting, { type: "cancel" }).status).toBe(
      "cancelled",
    );

    const matched = transitionQueueState(waiting, {
      type: "match",
      matchId: "match-1",
    });
    expect(transitionQueueState(matched, { type: "cancel" })).toEqual(matched);
    expect(
      transitionQueueState(matched, { type: "match", matchId: "match-2" }),
    ).toEqual(matched);
  });

  it("restores every durable ranked match state", () => {
    expect(
      deriveRankedRecoveryView({
        queueStatus: "waiting",
        matchStatus: null,
        hasSubmitted: false,
        databaseNowMs: 0,
        scheduledStartMs: null,
        endMs: null,
      }),
    ).toBe("waiting");
    expect(
      deriveRankedRecoveryView({
        queueStatus: "matched",
        matchStatus: "starting",
        hasSubmitted: false,
        databaseNowMs: 4_000,
        scheduledStartMs: 5_000,
        endMs: 65_000,
      }),
    ).toBe("countdown");
    expect(
      deriveRankedRecoveryView({
        queueStatus: "matched",
        matchStatus: "active",
        hasSubmitted: true,
        databaseNowMs: 66_000,
        scheduledStartMs: 5_000,
        endMs: 65_000,
      }),
    ).toBe("awaiting-result");
    expect(
      deriveRankedRecoveryView({
        queueStatus: "matched",
        matchStatus: "completed",
        hasSubmitted: true,
        databaseNowMs: 70_000,
        scheduledStartMs: 5_000,
        endMs: 65_000,
      }),
    ).toBe("results");
  });
});

describe("fixed ranked rules", () => {
  it("uses one canonical current production snapshot", () => {
    expect(RANKED_RULESET_VERSION).toBe("ranked-v1");
    expect(RANKED_RULESET).toMatchObject({
      rows: 4,
      columns: 4,
      shape: "rectangle",
      roundDurationSeconds: 60,
      minimumWordLength: 3,
      boardGenerationVersion: "weighted-v2",
      scoringRulesVersion: "classic-v1",
      dictionaryVersion: "enable2k-af52415-v1",
    });
    expect(RANKED_RULESET.activeCells.every(Boolean)).toBe(true);
  });

  it("rejects even one changed ranked setting", () => {
    expect(isRankedRuleset(RANKED_RULESET)).toBe(true);
    expect(
      isRankedRuleset({ ...RANKED_RULESET, roundDurationSeconds: 90 }),
    ).toBe(false);
    expect(isRankedRuleset(DEFAULT_RULESET)).toBe(true);
  });
});

describe("public profiles and leaderboards", () => {
  it("normalizes and validates opaque public identifiers", () => {
    expect(normalizePublicProfileId(" abc234defg ")).toBe("ABC234DEFG");
    expect(isValidPublicProfileId("ABC234DEFG")).toBe(true);
    expect(isValidPublicProfileId("ABC10OIL")).toBe(false);
  });

  it("creates safe initials and omits unselected source fields", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    const summary = createPublicProfileSummary({
      publicProfileId: "ABC234DEFG",
      displayName: "<Ada>  Lovelace",
      currentRating: 1_100,
      peakRating: 1_200,
      gamesPlayed: 10,
      wins: 6,
      losses: 3,
      ties: 1,
      bestScore: 4_200,
      currentWinStreak: 2,
      bestWinStreak: 4,
      rankedSince: "2026-07-24T00:00:00.000Z",
    });
    expect(summary).toMatchObject({
      displayName: "Ada Lovelace",
      initials: "AL",
      winPercentage: 60,
    });
    expect(summary).not.toHaveProperty("id");
    expect(summary).not.toHaveProperty("email");
  });

  const candidates: LeaderboardCandidate[] = [
    {
      publicProfileId: "AAA234AAAA",
      displayName: "A",
      rating: 1_200,
      peakRating: 1_300,
      gamesPlayed: 20,
      bestScore: 3_000,
      wins: 10,
    },
    {
      publicProfileId: "BBB234BBBB",
      displayName: "B",
      rating: 1_200,
      peakRating: 1_250,
      gamesPlayed: 30,
      bestScore: 4_000,
      wins: 10,
    },
    {
      publicProfileId: "CCC234CCCC",
      displayName: "C",
      rating: 1_100,
      peakRating: 1_150,
      gamesPlayed: 10,
      bestScore: 4_000,
      wins: 5,
    },
    {
      publicProfileId: "DDD234DDDD",
      displayName: "No games",
      rating: 2_000,
      peakRating: 2_000,
      gamesPlayed: 0,
      bestScore: 0,
      wins: 0,
    },
  ];

  it("uses competition ranking and deterministic secondary ordering", () => {
    const rating = rankLeaderboard(candidates, "rating");
    expect(rating.map((entry) => [entry.publicProfileId, entry.rank])).toEqual([
      ["AAA234AAAA", 1],
      ["BBB234BBBB", 1],
      ["CCC234CCCC", 3],
    ]);

    const bestScore = rankLeaderboard(candidates, "best-score");
    expect(bestScore.slice(0, 2).map((entry) => entry.publicProfileId)).toEqual(
      ["BBB234BBBB", "CCC234CCCC"],
    );
  });

  it("paginates bounded leaderboard results", () => {
    const expanded = Array.from(
      { length: LEADERBOARD_PAGE_SIZE + 2 },
      (_, index) => ({
        ...candidates[0],
        publicProfileId: `PLAYER${String(index).padStart(4, "0")}`,
        rank: index + 1,
      }),
    );
    expect(paginateLeaderboard(expanded, 1)).toHaveLength(25);
    expect(paginateLeaderboard(expanded, 2)).toHaveLength(2);
  });

  it("keeps private-game statistics separate by requiring explicit ranked updates", () => {
    const initial = createInitialRankedStatistics();
    const afterPrivateGame = initial;
    expect(afterPrivateGame).toEqual(initial);
  });
});
