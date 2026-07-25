import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const migrations = readdirSync(resolve(workspace, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) =>
    readFileSync(resolve(workspace, "supabase/migrations", name), "utf8"),
  )
  .join("\n");
const databaseTypes = readFileSync(
  resolve(workspace, "src/lib/supabase/database.types.ts"),
  "utf8",
);

const requiredSignatures = [
  "get_current_player_challenges()",
  "create_player_challenge(text, boolean)",
  "respond_player_challenge(uuid, boolean)",
  "cancel_player_challenge(uuid)",
  "get_two_player_rematch_state(uuid)",
  "request_two_player_rematch(uuid)",
  "respond_two_player_rematch(uuid, boolean)",
  "cancel_two_player_rematch(uuid)",
  "get_match_preview_state(uuid)",
  "vote_match_reroll_cycle(uuid, integer, boolean)",
  "vote_match_reroll(uuid, boolean)",
  "vote_match_countdown_skip(uuid, integer)",
  "get_match_word_opportunities(uuid)",
] as const;

describe("application RPC contract", () => {
  it("passes the build-time caller, migration, and generated-type check", () => {
    expect(() =>
      execFileSync("node", ["scripts/check-rpc-contract.mjs"], {
        cwd: workspace,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.each(requiredSignatures)(
    "keeps authenticated-only execution for public.%s",
    (signature) => {
      const escapedSignature = signature
        .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        .replace(/\\\(/u, "\\s*\\(\\s*")
        .replace(/, /gu, ",\\s*")
        .replace(/\\\)/u, "\\s*\\)");
      expect(migrations).toMatch(
        new RegExp(
          `revoke all on function public\\.${escapedSignature}\\s+from public, anon, authenticated`,
          "iu",
        ),
      );
      expect(migrations).toMatch(
        new RegExp(
          `grant execute on function public\\.${escapedSignature}\\s+to authenticated`,
          "iu",
        ),
      );
    },
  );

  it.each(
    requiredSignatures.map((signature) =>
      signature.slice(0, signature.indexOf("(")),
    ),
  )("includes %s in generated database types", (name) => {
    expect(databaseTypes).toMatch(new RegExp(`^\\s{6}${name}:\\s*\\{`, "mu"));
  });
});
