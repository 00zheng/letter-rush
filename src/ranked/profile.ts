import { sanitizeDisplayName } from "@/multiplayer/display-name";

export const PUBLIC_PROFILE_ID_LENGTH = 10;
const PUBLIC_PROFILE_ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/u;

export function normalizePublicProfileId(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidPublicProfileId(value: string): boolean {
  return PUBLIC_PROFILE_ID_PATTERN.test(normalizePublicProfileId(value));
}

export function getInitials(displayName: string): string {
  const parts = sanitizeDisplayName(displayName).split(" ").filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`
      : parts[0]?.slice(0, 2);
  return (initials || "LR").toUpperCase();
}

export type PublicProfileSource = {
  publicProfileId: string;
  displayName: string;
  currentRating: number;
  peakRating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  bestScore: number;
  currentWinStreak: number;
  bestWinStreak: number;
  rankedSince: string;
};

export type PublicProfileSummary = PublicProfileSource & {
  initials: string;
  winPercentage: number;
};

export function createPublicProfileSummary(
  source: PublicProfileSource,
): PublicProfileSummary | null {
  const publicProfileId = normalizePublicProfileId(source.publicProfileId);
  if (!isValidPublicProfileId(publicProfileId)) return null;

  const displayName = sanitizeDisplayName(source.displayName);
  if (!displayName) return null;

  return {
    publicProfileId,
    displayName,
    currentRating: source.currentRating,
    peakRating: source.peakRating,
    gamesPlayed: source.gamesPlayed,
    wins: source.wins,
    losses: source.losses,
    ties: source.ties,
    bestScore: source.bestScore,
    currentWinStreak: source.currentWinStreak,
    bestWinStreak: source.bestWinStreak,
    rankedSince: source.rankedSince,
    initials: getInitials(displayName),
    winPercentage:
      source.gamesPlayed === 0
        ? 0
        : Math.round((source.wins / source.gamesPlayed) * 1_000) / 10,
  };
}
