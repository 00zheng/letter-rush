import type { MatchStatus } from "./types";

export type LobbyJoinCheck =
  | { allowed: true; playerNumber: number }
  | {
      allowed: false;
      reason: "not-waiting" | "duplicate-player" | "full";
    };

export function checkLobbyJoin(input: {
  status: MatchStatus;
  currentUserId: string;
  playerUserIds: readonly string[];
  maximumPlayers: number;
}): LobbyJoinCheck {
  if (input.status !== "waiting") {
    return { allowed: false, reason: "not-waiting" };
  }
  if (input.playerUserIds.includes(input.currentUserId)) {
    return { allowed: false, reason: "duplicate-player" };
  }
  if (input.playerUserIds.length >= input.maximumPlayers) {
    return { allowed: false, reason: "full" };
  }
  return { allowed: true, playerNumber: input.playerUserIds.length + 1 };
}

export function canHostStartLobby(input: {
  status: MatchStatus;
  hostUserId: string;
  currentUserId: string;
  participantCount: number;
}): boolean {
  return (
    input.status === "waiting" &&
    input.hostUserId === input.currentUserId &&
    input.participantCount >= 2
  );
}
