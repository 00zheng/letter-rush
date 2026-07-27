import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} is incomplete`).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe("mutual preview voting", () => {
  const migration = source(
    "supabase/migrations/20260727010000_mutual_preview_votes_and_rematch_lobby_return.sql",
  );
  const reroll = functionDefinition(
    migration,
    "public.vote_match_reroll_cycle",
  );
  const skip = functionDefinition(
    migration,
    "public.vote_match_countdown_skip",
  );
  const preview = source("src/components/pregame-preview.tsx");

  it("records one idempotent affirmative reroll vote and caps completions at three", () => {
    expect(reroll).toContain(
      "on conflict on constraint match_reroll_votes_pkey",
    );
    expect(reroll).toContain("locked_match.reroll_sequence >= 3");
    expect(reroll).toContain("match_row.reroll_sequence < 3");
    expect(reroll).toContain("reroll_sequence = match_row.reroll_sequence + 1");
    expect(reroll).toContain("approval_count = player_count");
    expect(reroll).not.toContain("not vote.approve");
    expect(reroll).not.toContain("set reroll_status = 'declined'");
  });

  it("records one skip vote and advances the shared start only once after unanimity", () => {
    expect(skip).toContain(
      "on conflict on constraint match_countdown_skip_votes_pkey",
    );
    expect(skip).toContain("approval_count = player_count");
    expect(skip).toContain("match_row.scheduled_start_at > synchronized_start");
    expect(skip).not.toContain("Finish the reroll vote");
  });

  it("renders only the two requested controls and restores the caller's submitted state", () => {
    expect(preview).toContain('"get_my_match_preview_votes"');
    expect(preview).toMatch(/>\s*Reroll\s*</u);
    expect(preview).toMatch(/>\s*Skip Countdown\s*</u);
    expect(preview).toContain("Reroll vote submitted.");
    expect(preview).toContain("Skip vote submitted.");
    expect(preview).not.toContain("Approve reroll");
    expect(preview).not.toContain("Decline reroll");
    expect(preview).not.toContain("Request reroll");
    expect(preview).not.toContain("voteReroll(false");
  });
});

describe("direct room and rematch navigation", () => {
  const gameApp = source("src/components/game-app.tsx");
  const authPanel = source("src/components/auth-panel.tsx");
  const rematch = source("src/components/rematch-controls.tsx");

  it("auto-joins a room query once while preserving manual retry", () => {
    expect(gameApp).toContain("setDirectRoomCode(inviteCode)");
    expect(gameApp).toContain("autoJoinAttemptedRef");
    expect(gameApp).toContain("joinInFlightRef");
    expect(gameApp).toContain("void joinRoomByCode(directRoomCode, true)");
    expect(gameApp).toContain("await joinRoomByCode(roomCode)");
    expect(gameApp).toContain("Joining room {roomCode}");
  });

  it("preserves the room continuation through sign-in and account claiming", () => {
    expect(gameApp).toContain('roomCode ? `/?room=${roomCode}` : "/"');
    expect(authPanel).toContain("claimContinuation");
    expect(authPanel).toContain("router.replace(next)");
  });

  it("sends both terminal rematch states to the lobby without a private restore loop", () => {
    expect(rematch).toContain("redirectingRef");
    expect(rematch).toContain(
      "window.localStorage.removeItem(ACTIVE_MATCH_KEY)",
    );
    expect(rematch).toContain('["declined", "expired", "cancelled"].includes');
    expect(rematch).toContain("returnToLobby()");
    expect(rematch).toContain("useState(15)");
  });
});
