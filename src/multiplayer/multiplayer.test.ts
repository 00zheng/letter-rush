import { describe, expect, it } from "vitest";

import { DEFAULT_BOARD } from "../game/board";
import { DICTIONARY_VERSION } from "../game/ruleset";
import type { WordPathSubmission } from "../game/types";

import { createGuestName, sanitizeDisplayName } from "./display-name";
import { normalizeRoomCode, validateRoomCode } from "./room-code";
import {
  calculateServerClockOffset,
  compareMatchResults,
  deriveMultiplayerView,
  rankMatchResults,
  resolveRestorableMatchId,
} from "./state";
import type { MatchPlayerRecord, MatchRecord } from "./types";
import {
  applyIdempotentSubmission,
  isWithinResultSubmissionWindow,
  parseResultRequest,
  validateMatchSubmissions,
} from "./validation";

const MATCH: MatchRecord = {
  id: "27a7318b-c4de-4f72-8d4f-bba9706e7f69",
  room_code: "ABC234",
  status: "starting",
  host_user_id: "host",
  board_seed: 42,
  round_duration_seconds: 60,
  scheduled_start_at: "2026-07-24T01:00:05.000Z",
  created_at: "2026-07-24T01:00:00.000Z",
  completed_at: null,
  winner_id: null,
  is_tie: false,
  max_players: 2,
  ruleset: {},
  dictionary_version: DICTIONARY_VERSION,
  board_generation_version: "legacy-v1",
  ruleset_version: "2",
  mode: "private",
  scoring_version: "classic-v1",
  ranked_ruleset_version: null,
  rating_status: "not_applicable",
  rating_applied_at: null,
  mode_key: "private:00000000000000000000000000000000",
  rematch_of: null,
  preview_started_at: "2025-01-01T00:00:00.000Z",
  preview_ends_at: "2025-01-01T00:00:05.000Z",
  reroll_used: false,
  reroll_status: "idle",
  reroll_requested_by: null,
  reroll_requested_at: null,
};

const PLAYERS: MatchPlayerRecord[] = [
  {
    match_id: MATCH.id,
    player_user_id: "host",
    player_number: 1,
    joined_at: MATCH.created_at,
    finished_at: null,
    validated_score: null,
    validated_words: [],
    result_status: "pending",
  },
  {
    match_id: MATCH.id,
    player_user_id: "guest",
    player_number: 2,
    joined_at: MATCH.created_at,
    finished_at: null,
    validated_score: null,
    validated_words: [],
    result_status: "pending",
  },
];

const CAT: WordPathSubmission = {
  word: "CAT",
  path: [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
  ],
};

const CARE: WordPathSubmission = {
  word: "CARE",
  path: [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 1, column: 0 },
    { row: 1, column: 1 },
  ],
};

const CRATE: WordPathSubmission = {
  word: "CRATE",
  path: [
    { row: 0, column: 0 },
    { row: 1, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
    { row: 1, column: 1 },
  ],
};

describe("room codes", () => {
  it("normalizes harmless formatting and letter case", () => {
    expect(normalizeRoomCode(" ab-c 234 ")).toBe("ABC234");
  });

  it("accepts only six unambiguous characters", () => {
    expect(validateRoomCode("ABC234").isValid).toBe(true);
    expect(validateRoomCode("ABC01I").isValid).toBe(false);
    expect(validateRoomCode("SHORT").isValid).toBe(false);
  });
});

describe("display names", () => {
  it("sanitizes and limits names", () => {
    expect(sanitizeDisplayName("  Ada <script> Lovelace  ")).toBe(
      "Ada script Lovelace",
    );
    expect(sanitizeDisplayName("x".repeat(30))).toHaveLength(24);
  });

  it("creates a stable guest name from a user ID", () => {
    expect(createGuestName("27a7318b-c4de-4f72-8d4f-bba9706e7f69")).toBe(
      createGuestName("27a7318b-c4de-4f72-8d4f-bba9706e7f69"),
    );
    expect(createGuestName("not-a-uuid")).toMatch(/^Guest \d{4}$/);
  });
});

describe("multiplayer state", () => {
  it("transitions from countdown to playing and then submission", () => {
    expect(
      deriveMultiplayerView({
        match: MATCH,
        players: PLAYERS,
        currentUserId: "host",
        serverNowMs: Date.parse("2026-07-24T01:00:04.000Z"),
      }),
    ).toBe("countdown");

    expect(
      deriveMultiplayerView({
        match: MATCH,
        players: PLAYERS,
        currentUserId: "host",
        serverNowMs: Date.parse("2026-07-24T01:00:20.000Z"),
      }),
    ).toBe("playing");

    expect(
      deriveMultiplayerView({
        match: MATCH,
        players: PLAYERS,
        currentUserId: "host",
        serverNowMs: Date.parse("2026-07-24T01:01:05.000Z"),
      }),
    ).toBe("submitting");
  });

  it("compares match results", () => {
    expect(compareMatchResults(800, 400)).toBe("win");
    expect(compareMatchResults(100, 400)).toBe("loss");
    expect(compareMatchResults(400, 400)).toBe("tie");
  });

  it("ranks 2, 3, and 12 players with shared placements for ties", () => {
    const players = Array.from({ length: 12 }, (_, index) => ({
      player_user_id: `player-${index + 1}`,
      player_number: index + 1,
      validated_score:
        index === 0 || index === 1 ? 2_200 : Math.max(0, 1_800 - index * 100),
    }));
    const ranked = rankMatchResults(players);

    expect(ranked).toHaveLength(12);
    expect(ranked.slice(0, 3).map(({ placement }) => placement)).toEqual([
      1, 1, 3,
    ]);
    expect(rankMatchResults(players.slice(0, 2))).toHaveLength(2);
    expect(rankMatchResults(players.slice(0, 3))).toHaveLength(3);
  });

  it("restores only a match the signed-in player can access", () => {
    expect(
      resolveRestorableMatchId({
        explicitMatchId: "private",
        storedMatchId: MATCH.id,
        availableMatchIds: [MATCH.id],
      }),
    ).toBe(MATCH.id);
    expect(
      resolveRestorableMatchId({
        explicitMatchId: null,
        storedMatchId: "private",
        availableMatchIds: [MATCH.id],
      }),
    ).toBeNull();
  });

  it("uses a server clock sample to correct client drift", () => {
    expect(
      calculateServerClockOffset(
        "2026-07-24T01:00:05.000Z",
        Date.parse("2026-07-24T01:00:00.000Z"),
      ),
    ).toBe(5_000);
  });
});

describe("server-side submission validation", () => {
  it("validates paths, dictionary words, and recomputes the score", async () => {
    expect(await validateMatchSubmissions(DEFAULT_BOARD, [CAT, CARE])).toEqual({
      isValid: true,
      score: 500,
      submissions: [
        { ...CAT, score: 100 },
        { ...CARE, score: 400 },
      ],
    });
  });

  it("authoritatively accepts CRATE and recomputes its score", async () => {
    expect(await validateMatchSubmissions(DEFAULT_BOARD, [CRATE])).toEqual({
      isValid: true,
      score: 800,
      submissions: [{ ...CRATE, score: 800 }],
    });
  });

  it("rejects a word that does not match its path", async () => {
    expect(
      await validateMatchSubmissions(DEFAULT_BOARD, [{ ...CAT, word: "CARE" }]),
    ).toMatchObject({ isValid: false });
  });

  it("rejects invalid paths and out-of-dictionary words", async () => {
    expect(
      await validateMatchSubmissions(DEFAULT_BOARD, [
        {
          word: "CST",
          path: [
            { row: 0, column: 0 },
            { row: 0, column: 3 },
            { row: 0, column: 2 },
          ],
        },
      ]),
    ).toMatchObject({ isValid: false });

    expect(
      await validateMatchSubmissions(DEFAULT_BOARD, [
        {
          word: "CAE",
          path: [
            { row: 0, column: 0 },
            { row: 0, column: 1 },
            { row: 1, column: 1 },
          ],
        },
      ]),
    ).toMatchObject({
      isValid: false,
      message: "CAE is not in the approved dictionary.",
    });
  });

  it("rejects duplicate words", async () => {
    expect(
      await validateMatchSubmissions(DEFAULT_BOARD, [CAT, CAT]),
    ).toMatchObject({
      isValid: false,
      message: "CAT was submitted more than once.",
    });
  });

  it("accepts only the documented result submission time window", () => {
    expect(
      isWithinResultSubmissionWindow(
        "2026-07-24T01:00:00.000Z",
        60,
        "2026-07-24T01:01:14.999Z",
      ),
    ).toBe(true);
    expect(
      isWithinResultSubmissionWindow(
        "2026-07-24T01:00:00.000Z",
        60,
        "2026-07-24T01:01:15.001Z",
      ),
    ).toBe(false);
  });

  it("parses a bounded result request", () => {
    expect(
      parseResultRequest({ matchId: MATCH.id, submissions: [CAT] }),
    ).toEqual({
      isValid: true,
      matchId: MATCH.id,
      submissions: [CAT],
    });
  });

  it("keeps the first finalized result when a request is retried", () => {
    const first = {
      finishedAt: "2026-07-24T01:01:00.000Z",
      score: 100,
      words: ["CAT"],
    };

    expect(
      applyIdempotentSubmission(first, {
        finishedAt: "2026-07-24T01:01:01.000Z",
        score: 400,
        words: ["CARE"],
      }),
    ).toEqual({ changed: false, result: first });
  });
});
