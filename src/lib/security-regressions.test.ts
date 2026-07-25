import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const migrationsDirectory = resolve(workspace, "supabase/migrations");

function activeFunctionDefinitions() {
  const definitions = new Map<string, { migration: string; sql: string }>();

  for (const migration of readdirSync(migrationsDirectory)
    .filter((path) => path.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(resolve(migrationsDirectory, migration), "utf8");
    const starts = [
      ...sql.matchAll(/create or replace function\s+([a-z0-9_.]+)\s*\(/gi),
    ];

    for (const start of starts) {
      const startIndex = start.index ?? -1;
      expect(
        startIndex,
        `${migration}: ${start[1]} has no start`,
      ).toBeGreaterThanOrEqual(0);
      const end = sql.indexOf("\n$$;", startIndex);
      expect(
        end,
        `${migration}: ${start[1]} has no closing $$`,
      ).toBeGreaterThan(startIndex);
      definitions.set(start[1].toLowerCase(), {
        migration,
        sql: sql.slice(startIndex, end + 4),
      });
    }
  }

  return definitions;
}

describe("static security regressions", () => {
  it("never auto-signs a visitor into an anonymous session", () => {
    const sourceFiles = [
      "src/hooks/use-player-auth.ts",
      "src/components/auth-panel.tsx",
      "src/components/game-app.tsx",
    ]
      .map((path) => readFileSync(resolve(workspace, path), "utf8"))
      .join("\n");
    expect(sourceFiles).not.toContain("signInAnonymously");
  });

  it("keeps gameplay creation behind persistent authentication", () => {
    const game = readFileSync(
      resolve(workspace, "src/components/game-app.tsx"),
      "utf8",
    );
    const proxy = readFileSync(
      resolve(workspace, "src/lib/supabase/proxy.ts"),
      "utf8",
    );
    expect(game).toContain('auth.status !== "ready"');
    expect(proxy).toContain('pathname === "/quick-match"');
    expect(proxy).toContain('pathname.startsWith("/ranked/")');
    expect(proxy).toContain("destination.pathname = isAnonymous");
  });

  it("keeps the service worker away from auth and data traffic", () => {
    const worker = readFileSync(resolve(workspace, "public/sw.js"), "utf8");
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('url.pathname.startsWith("/auth/")');
    expect(worker).toContain('request.headers.has("authorization")');
    expect(worker).not.toContain('cache.put("/",');
  });

  it("gives every new SECURITY DEFINER an empty search path", () => {
    const migration = readFileSync(
      resolve(
        workspace,
        "supabase/migrations/20260724193900_persistent_accounts_gameplay_progression_schema.sql",
      ),
      "utf8",
    );
    const definitions = migration
      .split(/create or replace function /i)
      .slice(1);
    for (const definition of definitions) {
      if (/security definer/i.test(definition)) {
        expect(definition).toMatch(/security definer\s+set search_path = ''/i);
      }
    }
  });

  it("keeps PostgreSQL conditional expressions unqualified in active functions", () => {
    const repairMigration = "20260724203145_fix_qualified_sql_expressions.sql";
    const repairedFunctions = [
      "private.is_persistent_caller",
      "private.handle_new_auth_user",
      "private.mode_key",
      "private.mode_display_label",
      "private.record_mode_statistics",
      "public.get_current_mode_stats",
      "public.get_public_mode_leaderboard",
      "public.get_public_player_mode_stats",
      "public.vote_match_reroll",
      "public.accept_private_rematch_invite",
    ];
    const definitions = activeFunctionDefinitions();

    for (const [name, definition] of definitions) {
      expect(
        definition.sql,
        `${name} is still using a schema-qualified conditional expression`,
      ).not.toMatch(/pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/i);
      if (/security definer/i.test(definition.sql)) {
        expect(definition.sql).toMatch(
          /security definer\s+set search_path = ''/i,
        );
      }
    }

    for (const name of repairedFunctions) {
      expect(definitions.get(name)?.migration).toBe(
        name === "private.mode_display_label" ||
          name === "public.vote_match_reroll"
          ? "20260725004120_custom_match_quality_challenges_and_word_opportunities.sql"
          : repairMigration,
      );
    }
  });

  it("keeps challenges UUID-private and private boards server-approved", () => {
    const migration = readFileSync(
      resolve(
        workspace,
        "supabase/migrations/20260725004120_custom_match_quality_challenges_and_word_opportunities.sql",
      ),
      "utf8",
    );
    const createChallenge = migration.slice(
      migration.indexOf(
        "create or replace function public.create_player_challenge",
      ),
      migration.indexOf(
        "create or replace function public.get_current_player_challenges",
      ),
    );
    const challengeProjection = createChallenge.slice(
      createChallenge.indexOf("returns table"),
      createChallenge.indexOf("language plpgsql"),
    );

    expect(migration).toContain("revoke all on table public.player_challenges");
    expect(migration).not.toMatch(
      /grant\s+select\s+on\s+(table\s+)?public\.player_challenges/i,
    );
    expect(challengeProjection).not.toMatch(
      /\b(challenger_id|challenged_id|user_id)\b/i,
    );
    expect(createChallenge).toContain(
      "current_user_id uuid := private.require_persistent_caller()",
    );
    expect(migration).toContain("private.solve_board_words");
    expect(migration).toContain("private.board_quality_report");
    expect(migration).toContain(
      "create trigger matches_validate_private_quality_board",
    );
    expect(migration).toMatch(
      /private\.select_quality_board_seed\(\s*normalized_ruleset/i,
    );
  });
});
