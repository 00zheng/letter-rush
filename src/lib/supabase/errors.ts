export type SupabaseErrorKind =
  | "missing_rpc"
  | "permission_denied"
  | "authentication_expired"
  | "constraint_violation"
  | "network_unavailable"
  | "request_timeout"
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
    text.includes("active match") ||
    text.includes("another match") ||
    text.includes("current multiplayer activity") ||
    text.includes("ranked matchmaking")
  ) {
    return { code, kind: "player_in_match_conflict", retryable: false };
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
    name === "aborterror" ||
    code === "57014" ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("canceling statement due to statement timeout")
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
  context: { feature: string; rpcName?: string },
): void {
  const classified = classifySupabaseError(error);
  const safeContext = {
    code: classified.code,
    feature: context.feature,
    kind: classified.kind,
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
      ? (error as ErrorLike).message
      : null;
  console.error("Supabase request failed.", { ...safeContext, message });
}
