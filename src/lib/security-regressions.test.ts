import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();

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
});
