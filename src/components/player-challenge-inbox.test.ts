import { describe, expect, it } from "vitest";

import type { PlayerChallenge } from "@/hooks/use-player-challenges";

import { selectVisiblePlayerChallenges } from "./player-challenge-inbox";

function challenge(overrides: Partial<PlayerChallenge> = {}): PlayerChallenge {
  return {
    challenge_id: "00000000-0000-0000-0000-000000000001",
    challenge_status: "pending",
    direction: "incoming",
    expires_at: "2026-07-25T12:00:00.000Z",
    match_id: null,
    match_mode: null,
    opponent_display_name: "Rival",
    opponent_public_profile_id: "ABCDEFG234",
    rated: false,
    room_code: null,
    server_now: "2026-07-25T11:59:50.000Z",
    ...overrides,
  };
}

describe("challenge banner selection", () => {
  it("hides the banner when there are no challenges", () => {
    expect(selectVisiblePlayerChallenges([])).toEqual({
      acceptedChallenge: undefined,
      incomingChallenge: undefined,
      outgoingChallenge: undefined,
    });
  });

  it("selects an incoming pending challenge", () => {
    const incoming = challenge();
    expect(selectVisiblePlayerChallenges([incoming]).incomingChallenge).toBe(
      incoming,
    );
  });

  it("selects an outgoing pending challenge", () => {
    const outgoing = challenge({ direction: "outgoing" });
    expect(selectVisiblePlayerChallenges([outgoing]).outgoingChallenge).toBe(
      outgoing,
    );
  });

  it("routes an accepted challenge with a match", () => {
    const accepted = challenge({
      challenge_status: "accepted",
      match_id: "00000000-0000-0000-0000-000000000002",
      match_mode: "private",
    });
    expect(selectVisiblePlayerChallenges([accepted]).acceptedChallenge).toBe(
      accepted,
    );
  });

  it.each(["declined", "expired", "cancelled"] as const)(
    "ignores a %s challenge",
    (challengeStatus) => {
      const result = selectVisiblePlayerChallenges([
        challenge({ challenge_status: challengeStatus }),
      ]);
      expect(result.acceptedChallenge).toBeUndefined();
      expect(result.incomingChallenge).toBeUndefined();
      expect(result.outgoingChallenge).toBeUndefined();
    },
  );
});
