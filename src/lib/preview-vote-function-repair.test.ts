import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const historicalMigration = readFileSync(
  resolve(
    workspace,
    "supabase/migrations/20260725215425_fix_preview_vote_board_revision_ambiguity.sql",
  ),
  "utf8",
);
const canonicalMigration = readFileSync(
  resolve(
    workspace,
    "supabase/migrations/20260725063941_repair_challenges_rematches_preview_votes_and_solver.sql",
  ),
  "utf8",
);
const repairMigration = readFileSync(
  resolve(
    workspace,
    "supabase/migrations/20260727000000_repair_preview_vote_functions_v2.sql",
  ),
  "utf8",
);

function functionDefinition(source: string, name: string): string {
  const start = source.indexOf(`create or replace function ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThanOrEqual(0);
  const comment = source.indexOf(`comment on function ${name}`, start);
  expect(comment, `${name} comment is missing`).toBeGreaterThan(start);
  const end = source.indexOf(";\n", comment);
  expect(end, `${name} comment is incomplete`).toBeGreaterThan(comment);
  return source.slice(start, end + 2);
}

function expectedDefinition(name: string): string {
  return functionDefinition(canonicalMigration, name)
    .replace(
      "on conflict (match_id, board_revision, vote_revision, user_id)",
      "on conflict on constraint match_reroll_votes_pkey",
    )
    .replace(
      "on conflict (match_id, board_revision, user_id) do nothing;",
      "on conflict on constraint match_countdown_skip_votes_pkey\n    do nothing;",
    );
}

describe("preview vote function v2 repair", () => {
  it("leaves the remotely recorded historical migration empty", () => {
    expect(historicalMigration).toBe("");
  });

  it.each([
    "public.vote_match_reroll_cycle",
    "public.vote_match_countdown_skip",
  ])(
    "preserves the canonical %s definition except conflict targeting",
    (name) => {
      expect(functionDefinition(repairMigration, name)).toBe(
        expectedDefinition(name),
      );
    },
  );

  it("targets the existing primary-key constraints without bare output-column conflicts", () => {
    expect(repairMigration).toContain(
      "on conflict on constraint match_reroll_votes_pkey",
    );
    expect(repairMigration).toContain(
      "on conflict on constraint match_countdown_skip_votes_pkey",
    );
    expect(repairMigration).not.toMatch(
      /on conflict\s*\([^)]*\bboard_revision\b[^)]*\)/iu,
    );
    expect(canonicalMigration).toMatch(
      /alter table public\.match_reroll_votes[\s\S]*add primary key \(match_id, board_revision, vote_revision, user_id\)/iu,
    );
    expect(canonicalMigration).toMatch(
      /create table public\.match_countdown_skip_votes[\s\S]*primary key \(match_id, board_revision, user_id\)/iu,
    );
  });
});
