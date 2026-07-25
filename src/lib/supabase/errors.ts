export type SupabaseErrorKind =
  | "missing_rpc"
  | "permission_denied"
  | "authentication_expired"
  | "constraint_violation"
  | "network_unavailable"
  | "request_timeout"
  | "statement_timeout"
  | "lobby_cancelled"
  | "ruleset_validation"
  | "ranked_matchmaking_conflict"
  | "room_code_allocation"
  | "player_in_match_conflict"
  | "challenge_already_pending"
  | "rematch_expired"
  | "reroll_vote_closed"
  | "unknown";

export type ClassifiedSupabaseError = {
  code: string | null;
  kind: SupabaseErrorKind;
  retryable: boolean;
};

type ErrorLike = {
  code?: unknown;
  details?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
};

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const candidate = error as ErrorLike;
  return [candidate.message, candidate.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as ErrorLike).code;
  return typeof code === "string" ? code.toUpperCase() : null;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as ErrorLike).status;
  return typeof status === "number" ? status : null;
}

export function classifySupabaseError(error: unknown): ClassifiedSupabaseError {
  const code = errorCode(error);
  const status = errorStatus(error);
  const text = errorText(error);
  const name =
    error &&
    typeof error === "object" &&
    typeof (error as ErrorLike).name === "string"
      ? String((error as ErrorLike).name).toLowerCase()
      : "";

  if (
    code === "PGRST202" ||
    ((status === 404 || text.includes("schema cache")) &&
      (text.includes("function") || text.includes("rpc"))) ||
    /function .+ does not exist/u.test(text) ||
    text.includes("could not find the function")
  ) {
    return { code, kind: "missing_rpc", retryable: false };
  }

  if (
    text.includes("challenge") &&
    (text.includes("already pending") ||
      text.includes("already sent") ||
      text.includes("already challenged"))
  ) {
    return { code, kind: "challenge_already_pending", retryable: false };
  }

  if (
    text.includes("rematch") &&
    (text.includes("expired") || text.includes("no longer pending"))
  ) {
    return { code, kind: "rematch_expired", retryable: false };
  }

  if (
    (text.includes("reroll") ||
      text.includes("countdown voting") ||
      text.includes("board changed")) &&
    (text.includes("closed") ||
      text.includes("expired") ||
      text.includes("board changed"))
  ) {
    return { code, kind: "reroll_vote_closed", retryable: false };
  }

  if (
    /that (?:private )?(?:room|lobby) was cancelled\.?/u.test(text) ||
    /the lobby was explicitly cancelled\.?/u.test(text)
  ) {
    return { code, kind: "lobby_cancelled", retryable: false };
  }

  if (
    text.includes("ranked matchmaking") ||
    text.includes("waiting in ranked")
  ) {
    return { code, kind: "ranked_matchmaking_conflict", retryable: false };
  }

  if (
    text.includes("active match") ||
    text.includes("another match") ||
    text.includes("current multiplayer activity")
  ) {
    return { code, kind: "player_in_match_conflict", retryable: false };
  }

  if (
    text.includes("unique room code") ||
    text.includes("room code could not be generated") ||
    text.includes("room-code allocation")
  ) {
    return { code, kind: "room_code_allocation", retryable: true };
  }

  if (
    (text.includes("ruleset") ||
      text.includes("active cells") ||
      text.includes("active-cell") ||
      text.includes("board dimensions") ||
      text.includes("board rows") ||
      text.includes("board generation") ||
      text.includes("round duration") ||
      text.includes("minimum word length") ||
      text.includes("dictionary version") ||
      text.includes("maximum players")) &&
    (text.includes("invalid") ||
      text.includes("unsupported") ||
      text.includes("must") ||
      text.includes("required") ||
      text.includes("malformed") ||
      text.includes("supported") ||
      text.includes("does not match") ||
      text.includes("needs at least") ||
      text.includes("connected") ||
      text.includes(" from "))
  ) {
    return { code, kind: "ruleset_validation", retryable: false };
  }

  if (
    code === "PGRST301" ||
    code === "28000" ||
    (status === 401 && code !== "42501") ||
    text.includes("jwt expired") ||
    text.includes("invalid jwt") ||
    text.includes("session expired") ||
    text.includes("not authenticated")
  ) {
    return { code, kind: "authentication_expired", retryable: false };
  }

  if (
    code === "42501" ||
    text.includes("permission denied") ||
    text.includes("not permitted") ||
    text.includes("only match participants") ||
    text.includes("not a participant")
  ) {
    return { code, kind: "permission_denied", retryable: false };
  }

  if (
    code === "57014" ||
    text.includes("canceling statement due to statement timeout")
  ) {
    return { code, kind: "statement_timeout", retryable: true };
  }

  if (
    name === "aborterror" ||
    text.includes("timed out") ||
    text.includes("timeout")
  ) {
    return { code, kind: "request_timeout", retryable: true };
  }

  if (
    name === "typeerror" ||
    status === 0 ||
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("network request failed") ||
    text.includes("load failed")
  ) {
    return { code, kind: "network_unavailable", retryable: true };
  }

  if (code?.startsWith("23")) {
    return { code, kind: "constraint_violation", retryable: false };
  }

  return { code, kind: "unknown", retryable: true };
}

export function supabaseErrorMessage(
  error: unknown,
  options: {
    feature: string;
    productionMessage: string;
    rpcName?: string;
  },
): string {
  const classified = classifySupabaseError(error);

  if (classified.kind === "missing_rpc") {
    if (process.env.NODE_ENV !== "production" && options.rpcName) {
      return `Database function ${options.rpcName} is missing. Apply the latest Supabase migrations.`;
    }
    return `A server update is required for ${options.feature.toLowerCase()}. You can retry after it is applied.`;
  }

  switch (classified.kind) {
    case "authentication_expired":
      return "Your session expired. Sign in again, then retry.";
    case "permission_denied":
      return "Your account does not have permission to perform that action.";
    case "constraint_violation":
      return "That request conflicts with the current game state.";
    case "network_unavailable":
      return "The game service could not be reached. Check your connection and retry.";
    case "request_timeout":
      return "The game service took too long to respond. Please retry.";
    case "statement_timeout":
      return "The game service took too long to prepare that request. Please retry.";
    case "lobby_cancelled":
      return "That lobby was cancelled.";
    case "ruleset_validation":
      return "Those game rules are not supported. Review them and try again.";
    case "ranked_matchmaking_conflict":
      return "Leave ranked matchmaking before starting another match.";
    case "room_code_allocation":
      return "A room code could not be reserved. Please try again.";
    case "player_in_match_conflict":
      return "A player is already in another match or matchmaking activity.";
    case "challenge_already_pending":
      return "A challenge between these players is already pending.";
    case "rematch_expired":
      return "The rematch request expired.";
    case "reroll_vote_closed":
      return "That preview vote has closed. Refresh the shared board state.";
    default:
      return options.productionMessage;
  }
}

export function reportSupabaseError(
  error: unknown,
  context: {
    feature: string;
    requestGenerationId?: number;
    rpcName?: string;
  },
): void {
  const classified = classifySupabaseError(error);
  const safeContext = {
    code: classified.code,
    feature: context.feature,
    kind: classified.kind,
    requestGenerationId: context.requestGenerationId ?? null,
    rpc: context.rpcName ?? null,
  };

  if (process.env.NODE_ENV === "production") {
    console.error("Supabase request failed.", safeContext);
    return;
  }

  const message =
    error &&
    typeof error === "object" &&
    typeof (error as ErrorLike).message === "string"
      ? ((error as ErrorLike).message as string)
          .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, "[id]")
          .replace(/\s+(?:detail|hint|where|context):[\s\S]*$/iu, "")
          .slice(0, 240)
      : null;
  console.error("Supabase request failed.", { ...safeContext, message });
}

export function privateLobbyErrorMessage(error: unknown): string {
  switch (classifySupabaseError(error).kind) {
    case "statement_timeout":
    case "request_timeout":
      return "The lobby took too long to prepare. Please try again.";
    case "lobby_cancelled":
      return "That lobby was cancelled.";
    case "network_unavailable":
      return "The game service could not be reached. Check your connection and try again.";
    case "ruleset_validation":
      return "Those lobby rules are not valid. Review them and try again.";
    case "player_in_match_conflict":
      return "Finish your active match before creating another lobby.";
    case "ranked_matchmaking_conflict":
      return "Leave ranked matchmaking before creating a private lobby.";
    case "room_code_allocation":
      return "A room code could not be reserved. Please try again.";
    case "missing_rpc":
      return process.env.NODE_ENV === "production"
        ? "Private lobbies are temporarily unavailable. Please try again later."
        : "Database function create_private_lobby is missing. Apply the latest Supabase migrations.";
    case "permission_denied":
      return "Your account does not have permission to create a private lobby.";
    case "authentication_expired":
      return "Your session expired. Sign in again, then retry.";
    default:
      return "The lobby could not be created. Please try again.";
  }
}
