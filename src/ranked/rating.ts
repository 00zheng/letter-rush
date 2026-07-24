export const STARTING_RATING = 1_000;
export const RATING_K_FACTOR = 32;
export const MINIMUM_RATING = 100;

export type RankedOutcome = "win" | "loss" | "tie" | "forfeit";

export type RatingAdjustment = {
  firstBefore: number;
  firstDelta: number;
  firstAfter: number;
  secondBefore: number;
  secondDelta: number;
  secondAfter: number;
};

export type RankedStatistics = {
  currentRating: number;
  peakRating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  bestScore: number;
  totalScore: number;
  currentWinStreak: number;
  bestWinStreak: number;
  currentUnbeatenStreak: number;
};

export function expectedScore(
  playerRating: number,
  opponentRating: number,
): number {
  return 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
}

function actualScore(outcome: RankedOutcome): number {
  if (outcome === "win") return 1;
  if (outcome === "tie") return 0.5;
  return 0;
}

/**
 * Rounding is applied once for the first player and mirrored for the second.
 * The clamp is the intersection of both rating floors, preserving zero-sum.
 */
export function calculateRatingAdjustment(
  firstRating: number,
  secondRating: number,
  firstOutcome: RankedOutcome,
): RatingAdjustment {
  const roundedDelta = Math.round(
    RATING_K_FACTOR *
      (actualScore(firstOutcome) - expectedScore(firstRating, secondRating)),
  );
  const minimumDelta = MINIMUM_RATING - firstRating;
  const maximumDelta = secondRating - MINIMUM_RATING;
  const firstDelta = Math.max(
    minimumDelta,
    Math.min(maximumDelta, roundedDelta),
  );
  const secondDelta = firstDelta === 0 ? 0 : -firstDelta;

  return {
    firstBefore: firstRating,
    firstDelta,
    firstAfter: firstRating + firstDelta,
    secondBefore: secondRating,
    secondDelta,
    secondAfter: secondRating + secondDelta,
  };
}

export function createInitialRankedStatistics(): RankedStatistics {
  return {
    currentRating: STARTING_RATING,
    peakRating: STARTING_RATING,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    forfeits: 0,
    bestScore: 0,
    totalScore: 0,
    currentWinStreak: 0,
    bestWinStreak: 0,
    currentUnbeatenStreak: 0,
  };
}

export function applyRankedResult(
  statistics: RankedStatistics,
  input: {
    outcome: RankedOutcome;
    score: number;
    ratingAfter: number;
  },
): RankedStatistics {
  const isWin = input.outcome === "win";
  const isTie = input.outcome === "tie";
  const nextWinStreak = isWin ? statistics.currentWinStreak + 1 : 0;
  const nextUnbeatenStreak =
    isWin || isTie ? statistics.currentUnbeatenStreak + 1 : 0;

  return {
    currentRating: input.ratingAfter,
    peakRating: Math.max(statistics.peakRating, input.ratingAfter),
    gamesPlayed: statistics.gamesPlayed + 1,
    wins: statistics.wins + (isWin ? 1 : 0),
    losses:
      statistics.losses +
      (input.outcome === "loss" || input.outcome === "forfeit" ? 1 : 0),
    ties: statistics.ties + (isTie ? 1 : 0),
    forfeits: statistics.forfeits + (input.outcome === "forfeit" ? 1 : 0),
    bestScore: Math.max(statistics.bestScore, input.score),
    totalScore: statistics.totalScore + input.score,
    currentWinStreak: nextWinStreak,
    bestWinStreak: Math.max(statistics.bestWinStreak, nextWinStreak),
    currentUnbeatenStreak: nextUnbeatenStreak,
  };
}

export type RatingHistoryRecord = {
  matchId: string;
  ratingAfter: number;
};

export function applyRatingIdempotently(
  existing: readonly RatingHistoryRecord[],
  incoming: RatingHistoryRecord,
): {
  applied: boolean;
  history: RatingHistoryRecord[];
  result: RatingHistoryRecord;
} {
  const prior = existing.find((entry) => entry.matchId === incoming.matchId);
  if (prior) {
    return { applied: false, history: [...existing], result: prior };
  }

  return {
    applied: true,
    history: [...existing, incoming],
    result: incoming,
  };
}
