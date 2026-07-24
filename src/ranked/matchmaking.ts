export const INITIAL_RATING_GAP = 150;
export const RATING_GAP_STEP = 50;
export const RATING_GAP_STEP_MS = 10_000;
export const MAXIMUM_RATING_GAP = 600;
export const OPEN_MATCH_WAIT_MS = 90_000;
export const QUEUE_HEARTBEAT_INTERVAL_MS = 10_000;
export const QUEUE_STALE_AFTER_MS = 35_000;

export type RankedQueueEntry = {
  userId: string;
  ratingSnapshot: number;
  joinedAtMs: number;
  heartbeatAtMs: number;
};

export function allowedRatingGap(waitedMs: number): number {
  if (waitedMs > OPEN_MATCH_WAIT_MS) return Number.POSITIVE_INFINITY;

  return Math.min(
    MAXIMUM_RATING_GAP,
    INITIAL_RATING_GAP +
      Math.floor(Math.max(0, waitedMs) / RATING_GAP_STEP_MS) * RATING_GAP_STEP,
  );
}

export function isQueueEntryStale(
  heartbeatAtMs: number,
  databaseNowMs: number,
): boolean {
  return databaseNowMs - heartbeatAtMs > QUEUE_STALE_AFTER_MS;
}

export function areQueueEntriesCompatible(
  first: RankedQueueEntry,
  second: RankedQueueEntry,
  databaseNowMs: number,
): boolean {
  if (
    first.userId === second.userId ||
    isQueueEntryStale(first.heartbeatAtMs, databaseNowMs) ||
    isQueueEntryStale(second.heartbeatAtMs, databaseNowMs)
  ) {
    return false;
  }

  const longestWait = Math.max(
    databaseNowMs - first.joinedAtMs,
    databaseNowMs - second.joinedAtMs,
  );
  return (
    Math.abs(first.ratingSnapshot - second.ratingSnapshot) <=
    allowedRatingGap(longestWait)
  );
}

export type QueueLifecycleState =
  | { status: "idle" }
  | { status: "waiting"; heartbeatAtMs: number }
  | { status: "matched"; matchId: string }
  | { status: "cancelled" };

export type QueueLifecycleEvent =
  | { type: "enter"; databaseNowMs: number }
  | { type: "heartbeat"; databaseNowMs: number }
  | { type: "match"; matchId: string }
  | { type: "cancel" }
  | { type: "expire"; databaseNowMs: number };

export function transitionQueueState(
  state: QueueLifecycleState,
  event: QueueLifecycleEvent,
): QueueLifecycleState {
  if (event.type === "match") {
    return state.status === "waiting"
      ? { status: "matched", matchId: event.matchId }
      : state;
  }

  if (event.type === "enter") {
    return state.status === "matched"
      ? state
      : { status: "waiting", heartbeatAtMs: event.databaseNowMs };
  }

  if (event.type === "heartbeat") {
    return state.status === "waiting"
      ? { status: "waiting", heartbeatAtMs: event.databaseNowMs }
      : state;
  }

  if (event.type === "cancel") {
    return state.status === "waiting" ? { status: "cancelled" } : state;
  }

  if (
    state.status === "waiting" &&
    isQueueEntryStale(state.heartbeatAtMs, event.databaseNowMs)
  ) {
    return { status: "cancelled" };
  }

  return state;
}

export type RankedRecoveryView =
  | "not-queued"
  | "waiting"
  | "match-found"
  | "countdown"
  | "playing"
  | "awaiting-result"
  | "results";

export function deriveRankedRecoveryView(input: {
  queueStatus: "idle" | "waiting" | "matched" | null;
  matchStatus: "starting" | "active" | "completed" | "cancelled" | null;
  hasSubmitted: boolean;
  databaseNowMs: number;
  scheduledStartMs: number | null;
  endMs: number | null;
}): RankedRecoveryView {
  if (input.matchStatus === "completed") return "results";
  if (input.matchStatus === "starting" && input.scheduledStartMs !== null) {
    return input.databaseNowMs < input.scheduledStartMs
      ? "countdown"
      : "playing";
  }
  if (input.matchStatus === "active") {
    if (input.hasSubmitted) return "awaiting-result";
    if (input.endMs !== null && input.databaseNowMs >= input.endMs) {
      return "awaiting-result";
    }
    return "playing";
  }
  if (input.queueStatus === "matched") return "match-found";
  if (input.queueStatus === "waiting") return "waiting";
  return "not-queued";
}
