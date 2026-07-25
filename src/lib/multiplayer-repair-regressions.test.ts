import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const migrationName =
  "20260725063941_repair_challenges_rematches_preview_votes_and_solver.sql";
const migration = readFileSync(
  resolve(workspace, "supabase/migrations", migrationName),
  "utf8",
);

function functionDefinition(name: string): string {
  const start = migration.indexOf(`create or replace function ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("\n$$;", start);
  expect(end, `${name} has no closing delimiter`).toBeGreaterThan(start);
  return migration.slice(start, end + 4);
}

describe("multiplayer repair migration", () => {
  it("keeps every SECURITY DEFINER isolated and explicitly granted", () => {
    const definitions = migration
      .split(/create or replace function /iu)
      .slice(1);
    for (const definition of definitions) {
      if (!/security definer/iu.test(definition)) continue;
      expect(definition).toMatch(/security definer\s+set search_path = ''/iu);
      const signature = definition.match(/^([a-z0-9_.]+)\s*\(/iu)?.[1];
      expect(signature).toBeTruthy();
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function ${signature!.replace(".", "\\.")}`,
          "iu",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant execute on function ${signature!.replace(".", "\\.")}`,
          "iu",
        ),
      );
    }
  });

  it("uses canonical cleanup across every match-entry path", () => {
    for (const name of [
      "public.create_player_challenge",
      "public.respond_player_challenge",
      "public.create_private_lobby",
      "public.respond_two_player_rematch",
      "public.create_or_resume_solo_session",
      "public.enter_ranked_queue",
    ]) {
      expect(functionDefinition(name)).toContain(
        "private.cleanup_user_activity",
      );
    }
    expect(functionDefinition("private.user_has_active_match")).toContain(
      "match_row.status in ('waiting', 'starting', 'active')",
    );
  });

  it("keeps challenge authorization server-side and presence advisory", () => {
    const create = functionDefinition("public.create_player_challenge");
    const respond = functionDefinition("public.respond_player_challenge");
    expect(create).toContain("private.require_persistent_caller()");
    expect(create).toContain("interval '30 seconds'");
    expect(create).toContain("private.lock_user_activity_pair");
    expect(functionDefinition("private.lock_user_activity")).toContain(
      "pg_advisory_xact_lock",
    );
    expect(create).not.toMatch(/presence/iu);
    for (const message of [
      "You cannot challenge yourself",
      "Player profile was not found",
      "You are already in an active match",
      "That player is already in an active match",
      "You already sent this player a challenge",
      "That player already challenged you",
    ]) {
      expect(create).toContain(message);
    }
    expect(respond).toContain("challenge.challenged_id <> current_user_id");
    expect(respond).toContain("status = 'declined'");
    expect(respond).toContain("status = 'expired'");
    expect(respond).toContain("insert into public.match_players");
    expect(respond).toContain("preview_started_at");
    expect(respond).toContain("preview_ends_at");
  });

  it("creates complete, idempotent 15-second rematches", () => {
    const respond = functionDefinition("public.respond_two_player_rematch");
    expect(respond).toContain("database_now >= proposal.expires_at");
    expect(respond).toContain("proposal.created_match_id");
    expect(respond).toContain("preview_started_at");
    expect(respond).toContain("preview_ends_at");
    expect(respond).toContain("insert into public.match_players");
  });

  it("versions unlimited rerolls and database-authoritative skip votes", () => {
    const reroll = functionDefinition("public.vote_match_reroll_cycle");
    const skip = functionDefinition("public.vote_match_countdown_skip");
    expect(reroll).toContain("board_revision = match_row.board_revision + 1");
    expect(reroll).toContain("reroll_sequence = match_row.reroll_sequence + 1");
    expect(reroll).not.toMatch(/already used/iu);
    expect(skip).toContain("interval '750 milliseconds'");
    expect(skip).toContain("p_board_revision");
    expect(migration).toContain(
      "create table public.match_countdown_skip_votes",
    );
    expect(migration).toContain(
      "revoke all on table public.match_countdown_skip_votes",
    );
  });

  it("contains no invalid schema-qualified conditional expressions", () => {
    expect(migration).not.toMatch(
      /pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/iu,
    );
  });
});
