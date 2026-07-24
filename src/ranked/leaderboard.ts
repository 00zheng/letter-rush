export type LeaderboardCategory = "rating" | "best-score" | "wins";

export type LeaderboardCandidate = {
  publicProfileId: string;
  displayName: string;
  rating: number;
  peakRating: number;
  gamesPlayed: number;
  bestScore: number;
  wins: number;
};

export type RankedLeaderboardEntry = LeaderboardCandidate & {
  rank: number;
};

export const LEADERBOARD_PAGE_SIZE = 25;

function metric(
  entry: LeaderboardCandidate,
  category: LeaderboardCategory,
): number {
  if (category === "best-score") return entry.bestScore;
  if (category === "wins") return entry.wins;
  return entry.rating;
}

export function rankLeaderboard(
  entries: readonly LeaderboardCandidate[],
  category: LeaderboardCategory,
): RankedLeaderboardEntry[] {
  const sorted = entries
    .filter((entry) => entry.gamesPlayed > 0)
    .sort((first, second) => {
      const metricDifference =
        metric(second, category) - metric(first, category);
      if (metricDifference !== 0) return metricDifference;

      if (category === "rating") {
        return (
          second.peakRating - first.peakRating ||
          second.gamesPlayed - first.gamesPlayed ||
          first.publicProfileId.localeCompare(second.publicProfileId)
        );
      }

      return (
        second.rating - first.rating ||
        first.gamesPlayed - second.gamesPlayed ||
        first.publicProfileId.localeCompare(second.publicProfileId)
      );
    });

  return sorted.map((entry, index) => {
    const priorWithSameMetric = sorted.findIndex(
      (candidate) => metric(candidate, category) === metric(entry, category),
    );
    return { ...entry, rank: priorWithSameMetric + 1 || index + 1 };
  });
}

export function paginateLeaderboard(
  entries: readonly RankedLeaderboardEntry[],
  page: number,
  pageSize = LEADERBOARD_PAGE_SIZE,
): RankedLeaderboardEntry[] {
  const normalizedPage = Math.max(1, Math.trunc(page));
  const normalizedSize = Math.max(1, Math.trunc(pageSize));
  const start = (normalizedPage - 1) * normalizedSize;
  return entries.slice(start, start + normalizedSize);
}
