import type { MatchPlayerRecord, MatchRecord, PrivateRoomState } from "./types";

export type MultiplayerView =
  | "waiting"
  | "countdown"
  | "playing"
  | "submitting"
  | "waiting-for-opponent"
  | "results"
  | "cancelled";

type DeriveMultiplayerViewInput = {
  match: MatchRecord;
  players: MatchPlayerRecord[];
  currentUserId: string;
  serverNowMs: number;
};

export function getMatchEndTimeMs(match: MatchRecord): number | null {
  if (!match.scheduled_start_at) return null;

  return (
    Date.parse(match.scheduled_start_at) + match.round_duration_seconds * 1_000
  );
}

export function deriveMultiplayerView({
  match,
  players,
  currentUserId,
  serverNowMs,
}: DeriveMultiplayerViewInput): MultiplayerView {
  if (match.status === "cancelled") return "cancelled";
  if (match.status === "completed") return "results";

  const currentPlayer = players.find(
    (player) => player.player_user_id === currentUserId,
  );
  const opponents = players.filter(
    (player) => player.player_user_id !== currentUserId,
  );

  if (match.status === "waiting" || !match.scheduled_start_at) {
    return "waiting";
  }

  const startTimeMs = Date.parse(match.scheduled_start_at);
  const endTimeMs = getMatchEndTimeMs(match);

  if (serverNowMs < startTimeMs) return "countdown";

  if (currentPlayer?.finished_at) {
    return opponents.every((opponent) => opponent.finished_at)
      ? "results"
      : "waiting-for-opponent";
  }

  if (endTimeMs !== null && serverNowMs >= endTimeMs) return "submitting";

  return "playing";
}

export type MatchOutcome = "win" | "loss" | "tie";

export function compareMatchResults(
  currentPlayerScore: number,
  opponentScore: number,
): MatchOutcome {
  if (currentPlayerScore === opponentScore) return "tie";
  return currentPlayerScore > opponentScore ? "win" : "loss";
}

export type RankedMatchResult = {
  playerUserId: string;
  score: number;
  placement: number;
};

/**
 * Competition ranking: tied scores share a place and the next place skips by
 * the number of tied players (for example 1, 1, 3).
 */
export function rankMatchResults(
  players: readonly Pick<
    MatchPlayerRecord,
    "player_user_id" | "validated_score" | "player_number"
  >[],
): RankedMatchResult[] {
  const sorted = [...players].sort(
    (first, second) =>
      (second.validated_score ?? 0) - (first.validated_score ?? 0) ||
      first.player_number - second.player_number,
  );

  return sorted.map((player, index) => {
    const previous = sorted[index - 1];
    const placement =
      previous && previous.validated_score === player.validated_score
        ? index === 0
          ? 1
          : sorted
              .slice(0, index)
              .findIndex(
                (candidate) =>
                  candidate.validated_score === player.validated_score,
              ) + 1
        : index + 1;

    return {
      playerUserId: player.player_user_id,
      score: player.validated_score ?? 0,
      placement,
    };
  });
}

type RestoreMatchInput = {
  explicitMatchId: string | null;
  storedMatchId: string | null;
  availableMatchIds: readonly string[];
};

export function resolveRestorableMatchId({
  explicitMatchId,
  storedMatchId,
  availableMatchIds,
}: RestoreMatchInput): string | null {
  if (explicitMatchId && availableMatchIds.includes(explicitMatchId)) {
    return explicitMatchId;
  }

  if (storedMatchId && availableMatchIds.includes(storedMatchId)) {
    return storedMatchId;
  }

  return null;
}

export function calculateServerClockOffset(
  serverNow: string,
  clientNowMs: number,
): number {
  return Date.parse(serverNow) - clientNowMs;
}

export function withUpdatedServerTime(
  state: PrivateRoomState,
  serverNow: string,
): PrivateRoomState {
  return { ...state, serverNow };
}
