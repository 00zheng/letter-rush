import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const migrationsDirectory = resolve(workspace, "supabase/migrations");
const repairMigrationName =
  "20260725223244_repair_board_review_and_private_lobby_timeouts.sql";
const repairMigration = readFileSync(
  resolve(migrationsDirectory, repairMigrationName),
  "utf8",
);

function activeFunctionDefinitions(): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const migration of readdirSync(migrationsDirectory)
    .filter((path) => path.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(resolve(migrationsDirectory, migration), "utf8");
    for (const match of sql.matchAll(
      /create or replace function\s+([a-z0-9_.]+)\s*\(/giu,
    )) {
      const start = match.index;
      const end = sql.indexOf("\n$$;", start);
      expect(end, `${match[1]} has no closing delimiter`).toBeGreaterThan(
        start,
      );
      definitions.set(match[1].toLowerCase(), sql.slice(start, end + 4));
    }
  }
  return definitions;
}

describe("production reliability migration", () => {
  const definitions = activeFunctionDefinitions();

  it("makes the Board Review RPC authorized and cache-only", () => {
    const definition = definitions.get("public.get_match_word_opportunities")!;
    expect(definition).toContain("private.require_persistent_caller()");
    expect(definition).toContain("private.board_solution_cache");
    expect(definition).toContain("private.board_solution_words");
    expect(definition).not.toContain("private.cache_board_solution");
    expect(definition).not.toContain("private.solve_board_words");
    expect(definition).not.toMatch(/advisory/iu);
  });

  it("uses only bounded lightweight server-owned seed selection", () => {
    const selector = definitions.get("private.select_quality_board_seed")!;
    expect(selector).toContain("private.lightweight_board_quality_report");
    expect(selector).toContain("for attempt in 1..8 loop");
    expect(selector).toContain("for update skip locked");
    expect(selector).not.toContain("private.solve_board_words");
    expect(selector).not.toContain("private.cache_board_solution");
    expect(selector).not.toMatch(/pg_(?:try_)?advisory/iu);
  });

  it("keeps the private-board trigger fast and preserves its supplied server seed", () => {
    const trigger = definitions.get("private.enforce_private_board_quality")!;
    expect(trigger).toContain("private.validate_game_ruleset");
    expect(trigger).toContain("server-generated board seed");
    expect(trigger).not.toContain("private.select_quality_board_seed");
    expect(trigger).not.toContain("private.solve_board_words");
    expect(trigger).not.toContain("private.board_quality_report");
    expect(trigger).not.toContain("new.board_seed :=");
  });

  it("keeps lobby and rematch inserts atomic without client seed input", () => {
    const create = definitions.get("public.create_private_lobby")!;
    const groupRematch = definitions.get("public.create_private_rematch")!;
    const twoPlayerRematch = definitions.get(
      "public.respond_two_player_rematch",
    )!;
    expect(create).toContain("private.select_quality_board_seed");
    expect(create).toContain("insert into public.matches");
    expect(create).toContain("insert into public.match_players");
    expect(create).not.toMatch(/\bp_(?:board_)?seed\b/iu);
    expect(groupRematch).toContain("private.select_quality_board_seed");
    expect(twoPlayerRematch).toContain("private.select_quality_board_seed");
  });

  it("routes private rerolls through the same fast selector", () => {
    const reroll = definitions.get("public.vote_match_reroll_cycle")!;
    expect(reroll).toContain("private.select_quality_board_seed");
    expect(reroll).not.toContain("private.solve_board_words");
  });

  it("does not weaken official word, path, or score validation", () => {
    const submission = definitions.get("public.submit_match_result")!;
    expect(submission).toContain("private.approved_words");
    expect(submission).toContain("seen_tiles");
    expect(submission).toContain("total_score");
    expect(submission).not.toContain("p_score");
    expect(submission).not.toContain("p_winner");
  });

  it("keeps function privileges and SQL expressions safe", () => {
    expect(repairMigration).toMatch(
      /security definer\s+set search_path = ''/giu,
    );
    expect(repairMigration).toContain(
      "revoke all on function public.get_match_word_opportunities(uuid)",
    );
    expect(repairMigration).toContain(
      "grant execute on function public.get_match_word_opportunities(uuid)",
    );
    expect(repairMigration).not.toMatch(
      /pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/iu,
    );
  });
});
