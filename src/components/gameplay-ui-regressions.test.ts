import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(workspace, path), "utf8");
}

describe("active gameplay composition", () => {
  const game = source("src/components/letter-rush-game.tsx");
  const board = source("src/components/letter-board.tsx");
  const styles = source("src/components/letter-rush-game.module.css");

  it("removes the persistent current-word panel and Found Words sidebar", () => {
    expect(game).not.toContain("currentWordPanel");
    expect(game).not.toContain("DRAG!");
    expect(game).not.toContain("found-words-title");
    expect(game).not.toContain("styles.wordPanel");
  });

  it("does not render visual path-order numbers", () => {
    expect(board).not.toContain("stepBadge");
    expect(board).not.toContain("selectedIndex");
    expect(board).toContain("selected, ${selection.message}");
  });

  it("cleans pointer state on cancellation, capture loss, and interruption", () => {
    expect(board).toContain("onPointerCancel");
    expect(board).toContain("onLostPointerCapture");
    expect(board).toContain('window.addEventListener("blur"');
    expect(board).toContain('window.addEventListener("orientationchange"');
    expect(board).toContain("releasePointerCapture");
  });

  it("freezes interaction and final submission while an exit is pending", () => {
    expect(game).toContain("suppressCompletionRef.current = true");
    expect(game).toContain(
      'interactive={phase === "playing" && !isExitPending}',
    );
    expect(game).toContain("if (!suppressCompletionRef.current)");
  });

  it("places one compact scoreboard before the board", () => {
    expect(game.match(/styles\.compactScoreboard/g)).toHaveLength(1);
    expect(game.indexOf("styles.compactScoreboard")).toBeLessThan(
      game.indexOf("<LetterBoardSurface"),
    );
    expect(game).not.toContain("styles.scoreStrip");
    expect(game).not.toContain("styles.timerRing");
  });

  it("uses overlay word notices without changing board geometry", () => {
    expect(game).toContain("`${word} (+${formatScore(wordScore)})`");
    expect(game).toContain("`${word} — ALREADY FOUND`");
    expect(styles).toContain(".wordNoticeSlot");
    expect(styles).toMatch(/\.wordNotice\s*\{[\s\S]*position: absolute;/);
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("constrains active play to dynamic viewport space", () => {
    expect(styles).toMatch(/\.activeGameShell\s*\{[\s\S]*height: 100dvh;/);
    expect(styles).toMatch(/\.activeGameShell\s*\{[\s\S]*overflow: hidden;/);
    expect(styles).toContain(".boardStage");
    expect(styles).toContain("@media (max-width: 430px)");
  });
});

describe("normal header navigation", () => {
  it("places Guide immediately before Sign out for a signed-in player", () => {
    const header = source("src/components/app-header.tsx");
    const authenticatedNavigation = header.slice(
      header.indexOf('state.status === "ready"'),
      header.indexOf('state.status === "anonymous"'),
    );
    const leaderboard = header.indexOf('href="/leaderboards"');
    const profile = authenticatedNavigation.indexOf('href="/profile"');
    const guide = authenticatedNavigation.indexOf('href="/guide"');
    const signOut = authenticatedNavigation.indexOf("Sign out");

    expect(leaderboard).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(profile);
    expect(signOut).toBeGreaterThan(guide);
    expect(authenticatedNavigation).toMatch(
      /href="\/profile"[\s\S]*href="\/guide">Guide<\/Link>[\s\S]*<button[\s\S]*Sign out/,
    );
  });
});
