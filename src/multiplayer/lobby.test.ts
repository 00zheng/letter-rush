import { describe, expect, it } from "vitest";

import { canHostStartLobby, checkLobbyJoin } from "./lobby";

describe("generalized lobby transitions", () => {
  it.each([2, 3, 12])(
    "admits exactly %i players before becoming full",
    (max) => {
      const players = ["host"];
      while (players.length < max) {
        const userId = `guest-${players.length}`;
        expect(
          checkLobbyJoin({
            status: "waiting",
            currentUserId: userId,
            playerUserIds: players,
            maximumPlayers: max,
          }),
        ).toEqual({ allowed: true, playerNumber: players.length + 1 });
        players.push(userId);
      }

      expect(
        checkLobbyJoin({
          status: "waiting",
          currentUserId: "one-too-many",
          playerUserIds: players,
          maximumPlayers: max,
        }),
      ).toEqual({ allowed: false, reason: "full" });
    },
  );

  it("models serialized simultaneous joins against updated capacity", () => {
    const players = ["host"];
    const first = checkLobbyJoin({
      status: "waiting",
      currentUserId: "a",
      playerUserIds: players,
      maximumPlayers: 2,
    });
    expect(first.allowed).toBe(true);
    players.push("a");
    expect(
      checkLobbyJoin({
        status: "waiting",
        currentUserId: "b",
        playerUserIds: players,
        maximumPlayers: 2,
      }),
    ).toEqual({ allowed: false, reason: "full" });
  });

  it("rejects duplicate and post-countdown joins", () => {
    expect(
      checkLobbyJoin({
        status: "waiting",
        currentUserId: "host",
        playerUserIds: ["host"],
        maximumPlayers: 12,
      }),
    ).toEqual({ allowed: false, reason: "duplicate-player" });
    expect(
      checkLobbyJoin({
        status: "starting",
        currentUserId: "guest",
        playerUserIds: ["host"],
        maximumPlayers: 12,
      }),
    ).toEqual({ allowed: false, reason: "not-waiting" });
  });

  it("allows only the host to start with at least two players", () => {
    expect(
      canHostStartLobby({
        status: "waiting",
        hostUserId: "host",
        currentUserId: "host",
        participantCount: 2,
      }),
    ).toBe(true);
    expect(
      canHostStartLobby({
        status: "waiting",
        hostUserId: "host",
        currentUserId: "guest",
        participantCount: 12,
      }),
    ).toBe(false);
    expect(
      canHostStartLobby({
        status: "starting",
        hostUserId: "host",
        currentUserId: "host",
        participantCount: 12,
      }),
    ).toBe(false);
  });
});
