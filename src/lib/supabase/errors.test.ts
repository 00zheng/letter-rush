import { describe, expect, it } from "vitest";

import { classifySupabaseError, supabaseErrorMessage } from "./errors";

describe("Supabase error classification", () => {
  it.each([
    [{ code: "PGRST202", message: "Function missing" }, "missing_rpc"],
    [{ code: "42501", message: "permission denied" }, "permission_denied"],
    [
      { code: "42501", message: "permission denied", status: 401 },
      "permission_denied",
    ],
    [{ code: "PGRST301", message: "JWT expired" }, "authentication_expired"],
    [{ code: "23505", message: "duplicate key" }, "constraint_violation"],
    [{ name: "TypeError", message: "Failed to fetch" }, "network_unavailable"],
    [{ name: "AbortError", message: "aborted" }, "request_timeout"],
    [
      { message: "That player is already in an active match" },
      "player_in_match_conflict",
    ],
    [
      { message: "You already sent this player a challenge" },
      "challenge_already_pending",
    ],
    [{ message: "The rematch request expired" }, "rematch_expired"],
    [{ message: "Reroll voting is closed" }, "reroll_vote_closed"],
  ] as const)("classifies %o as %s", (error, kind) => {
    expect(classifySupabaseError(error).kind).toBe(kind);
  });

  it("names a missing RPC in development without exposing database details", () => {
    expect(
      supabaseErrorMessage(
        {
          code: "PGRST202",
          message:
            "Could not find the function public.get_current_player_challenges in the schema cache",
        },
        {
          feature: "Challenges",
          productionMessage: "Challenges could not be refreshed.",
          rpcName: "get_current_player_challenges",
        },
      ),
    ).toBe(
      "Database function get_current_player_challenges is missing. Apply the latest Supabase migrations.",
    );
  });
});
