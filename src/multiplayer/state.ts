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
  const opponent = players.find(
    (player) => player.player_user_id !== currentUserId,
  );

  if (!opponent || match.status === "waiting" || !match.scheduled_start_at) {
    return "waiting";
  }

  const startTimeMs = Date.parse(match.scheduled_start_at);
  const endTimeMs = getMatchEndTimeMs(match);

  if (serverNowMs < startTimeMs) return "countdown";

  if (currentPlayer?.finished_at) {
    return opponent.finished_at ? "results" : "waiting-for-opponent";
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
  clientNowMs = Date.now(),
): number {
  return Date.parse(serverNow) - clientNowMs;
}

export function withUpdatedServerTime(
  state: PrivateRoomState,
  serverNow: string,
): PrivateRoomState {
  return { ...state, serverNow };
}
