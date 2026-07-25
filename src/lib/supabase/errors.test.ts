import { describe, expect, it } from "vitest";

import {
  classifySupabaseError,
  privateLobbyErrorMessage,
  supabaseErrorMessage,
} from "./errors";

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
      {
        code: "57014",
        message: "canceling statement due to statement timeout",
      },
      "statement_timeout",
    ],
    [{ message: "That room was cancelled." }, "lobby_cancelled"],
    [
      { message: "Leave ranked matchmaking before creating a lobby" },
      "ranked_matchmaking_conflict",
    ],
    [
      { message: "A unique room code could not be generated. Try again." },
      "room_code_allocation",
    ],
    [
      { message: "Round duration must be from 10 through 180 seconds." },
      "ruleset_validation",
    ],
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

  it("never misclassifies PostgreSQL timeout cancellation as lobby cancellation", () => {
    const timeout = {
      code: "57014",
      message: "canceling statement due to statement timeout",
    };
    expect(classifySupabaseError(timeout).kind).toBe("statement_timeout");
    expect(privateLobbyErrorMessage(timeout)).toBe(
      "The lobby took too long to prepare. Please try again.",
    );
  });

  it("keeps genuine lobby cancellation distinct", () => {
    expect(
      privateLobbyErrorMessage({ message: "That lobby was cancelled." }),
    ).toBe("That lobby was cancelled.");
  });
});
