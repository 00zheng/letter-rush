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
    expect(board).toContain("selected, ${displayedSelection.message}");
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
      /href="\/profile"[\s\S]*href="\/guide"[\s\S]*label="Guide"[\s\S]*<button[\s\S]*Sign out/,
    );
  });

  it("keeps the settled account UI during background session refreshes", () => {
    const auth = source("src/hooks/use-player-auth.ts");
    const refreshHandler = auth.slice(
      auth.indexOf("client.auth.onAuthStateChange"),
      auth.indexOf("export function usePlayerAuth"),
    );

    expect(auth).toContain("useSyncExternalStore");
    expect(refreshHandler).toContain(
      'if (event === "TOKEN_REFRESHED") return;',
    );
    expect(refreshHandler).toContain("initializePlayerAuth()");
    expect(refreshHandler).not.toContain("initializePlayerAuth(true)");
  });
});

describe("gameplay UI regressions", () => {
  it("keeps private-lobby identity fixed after account setup", () => {
    const menu = source("src/components/game-app.tsx");
    const privateLobby = menu.slice(
      menu.indexOf("styles.privateCard"),
      menu.indexOf("styles.privacyNote"),
    );
    const auth = source("src/hooks/use-player-auth.ts");

    expect(privateLobby).not.toContain("Playing as");
    expect(privateLobby).not.toContain("Edit name");
    expect(privateLobby).not.toContain("display-name");
    expect(auth).not.toContain("updateDisplayName");
    expect(auth).not.toContain("isSavingName");
  });

  it("puts rematch actions before detailed results in every match mode", () => {
    const privateRoom = source("src/components/private-match-room.tsx");
    const privateResults = privateRoom.slice(
      privateRoom.indexOf('if (view === "results")'),
      privateRoom.indexOf("const finishedPlayers"),
    );
    const rankedRoom = source("src/components/ranked-match-room.tsx");
    const rankedResults = rankedRoom.slice(
      rankedRoom.indexOf('room.match.status === "completed"'),
      rankedRoom.indexOf('room.match.status === "cancelled"'),
    );

    expect(privateResults.indexOf("<TwoPlayerRematchControls")).toBeLessThan(
      privateResults.indexOf("styles.resultGrid"),
    );
    expect(privateResults.indexOf("<PrivateRematchControl")).toBeLessThan(
      privateResults.indexOf("styles.resultGrid"),
    );
    expect(rankedResults.indexOf("<TwoPlayerRematchControls")).toBeLessThan(
      rankedResults.indexOf("styles.resultGrid"),
    );
  });

  it("keeps the notification strip between the scoreboard and board", () => {
    const game = source("src/components/letter-rush-game.tsx");
    const board = source("src/components/letter-board.tsx");
    expect(game.indexOf("compactScoreboard")).toBeLessThan(
      game.indexOf("<LetterBoardSurface"),
    );
    expect(board.indexOf("wordNoticeSlot")).toBeLessThan(
      board.indexOf("boardStage"),
    );
  });

  it("uses cached directional geometry and only fixed center polylines", () => {
    const board = source("src/components/letter-board.tsx");
    expect(board).toContain("tileGeometryRef");
    expect(board).toContain("acquireDirectionalTileCoordinates");
    expect(board).toContain("<polyline");
    expect(board).not.toContain("<line");
    expect(board).not.toContain("trailingLineRef");
    expect(board).not.toContain("document.elementFromPoint");
  });

  it("keeps app chrome nonselectable while preserving zoom and inputs", () => {
    const boardStyles = source("src/components/letter-rush-game.module.css");
    const globalStyles = source("src/app/globals.css");
    const layout = source("src/app/layout.tsx");
    expect(boardStyles).toContain("touch-action: none");
    expect(boardStyles).toContain("-webkit-touch-callout: none");
    expect(boardStyles).toContain("-webkit-tap-highlight-color: transparent");
    expect(globalStyles).toContain(".app-shell");
    expect(globalStyles).toContain('[data-selectable="true"]');
    expect(globalStyles).toContain('[data-copyable="true"]');
    expect(globalStyles).toContain(
      '[contenteditable]:not([contenteditable="false"])',
    );
    expect(globalStyles).toContain(".app-shell option");
    expect(globalStyles).toContain("user-select: text");
    expect(globalStyles).toContain("touch-action: manipulation");
    expect(globalStyles).toContain("-webkit-tap-highlight-color: transparent");
    expect(layout).not.toMatch(/user-scalable|maximum-scale/i);
    expect(source("src/app/guide/page.tsx")).toContain(
      'data-selectable="true"',
    );
    const privateRoom = source("src/components/private-match-room.tsx");
    expect(privateRoom).toContain('data-copyable="true"');
    expect(privateRoom).toContain("className={styles.inviteLink}");
    expect(privateRoom).toContain("href={inviteUrl}");
  });

  it("keeps ordinary pages vertically scrollable and locks only interaction", () => {
    const globalStyles = source("src/app/globals.css");
    const menuStyles = source("src/components/game-app.module.css");
    const board = source("src/components/letter-board.tsx");
    expect(globalStyles).toMatch(/html\s*\{[\s\S]*height: auto;/);
    expect(globalStyles).toMatch(/html\s*\{[\s\S]*overflow-y: auto;/);
    expect(globalStyles).toMatch(/body\s*\{[\s\S]*overflow-y: visible;/);
    expect(globalStyles).not.toMatch(
      /(?:html|body)\s*\{[^}]*overflow:\s*hidden/iu,
    );
    expect(menuStyles).toContain("max(56px, env(safe-area-inset-bottom))");
    expect(board).toContain('document.body.style.overflow = "hidden"');
    expect(board).toContain("document.body.style.overflow = previousOverflow");
  });

  it("offers only the 4 by 4 preset and custom dimensions through 10", () => {
    const rules = source("src/game/ruleset.ts");
    const configurator = source("src/components/lobby-configurator.tsx");
    expect(rules).toContain("BOARD_SIZE_PRESETS = [4]");
    expect(rules).toContain("MAXIMUM_BOARD_DIMENSION = 10");
    expect(configurator).toContain('<option value="custom">Custom</option>');
    expect(configurator).not.toContain("Custom rectangle");
    expect(configurator).toContain("rowInput");
    expect(configurator).toContain("commitDimensionInputs");
    expect(configurator).toContain("Allowed: 3–10");
  });

  it("offers either sixty seconds or a bounded custom round time", () => {
    const rules = source("src/game/ruleset.ts");
    const configurator = source("src/components/lobby-configurator.tsx");
    expect(rules).toContain("DEFAULT_ROUND_DURATION_SECONDS = 60");
    expect(rules).toContain("MINIMUM_ROUND_DURATION_SECONDS = 10");
    expect(rules).toContain("MAXIMUM_ROUND_DURATION_SECONDS = 180");
    expect(configurator).toContain('<option value="preset">');
    expect(configurator).toContain('<option value="custom">Custom</option>');
    expect(configurator).toContain("Custom time (seconds)");
    expect(configurator).not.toContain("ROUND_DURATION_OPTIONS");
  });

  it("gives custom cells non-color semantics and connectivity feedback", () => {
    const configurator = source("src/components/lobby-configurator.tsx");
    expect(configurator).toContain('active ? "included" : "excluded"');
    expect(configurator).toContain('active ? "✓" : ""');
    expect(configurator).toContain("Board cell legend");
    expect(configurator).toContain('"connected" : "disconnected"');
  });

  it("uses the mutual 15-second rematch RPCs for two-player results", () => {
    const controls = source("src/components/rematch-controls.tsx");
    expect(controls).toContain("request_two_player_rematch");
    expect(controls).toContain("respond_two_player_rematch");
    expect(controls).toContain("cancel_two_player_rematch");
    expect(controls).toContain("get_two_player_rematch_state");
    expect(controls).toContain("two_player_rematch_proposals");
    expect(controls).toContain("useState(15)");
  });

  it("vibrates only after a released word is accepted", () => {
    const game = source("src/components/letter-rush-game.tsx");
    const acceptedIndex = game.indexOf(
      'showWordNotice("accepted", `${word} (+${formatScore(wordScore)})`)',
    );
    const hapticIndex = game.indexOf("triggerAcceptedWordHaptic();");
    expect(game).toContain("navigator.vibrate(12)");
    expect(game).toContain("function queuePathSubmission(path");
    expect(hapticIndex).toBeGreaterThan(acceptedIndex);
    expect(game.slice(0, acceptedIndex)).not.toContain(
      "triggerAcceptedWordHaptic();",
    );
  });

  it("shows three recent ranked matches and both challenge choices", () => {
    const profiles = source("src/components/ranked-pages.tsx");
    const challenge = source("src/components/profile-challenge-controls.tsx");
    expect(profiles).toContain("p_limit: 3");
    expect(challenge).toContain("Challenge for Elo");
    expect(challenge).toContain("Challenge casually");
    expect(challenge).toContain('"create_player_challenge"');
    expect(challenge).toContain('"respond_player_challenge"');
  });

  it("uses the server result contract with an exact-board worker fallback", () => {
    const game = source("src/components/letter-rush-game.tsx");
    const ranked = source("src/components/ranked-match-room.tsx");
    const privateRoom = source("src/components/private-match-room.tsx");
    const opportunities = source("src/components/word-opportunities.tsx");
    expect(game).toContain("<WordOpportunities");
    expect(ranked).toContain("<WordOpportunities");
    expect(privateRoom).toContain("<WordOpportunities");
    expect(opportunities).toContain("10 longest possible words");
    expect(opportunities).toContain('entry.was_found ? " · Found"');
    expect(source("src/hooks/use-word-opportunities.ts")).toContain(
      '"get_match_word_opportunities"',
    );
    expect(source("src/game/board-solver-client.ts")).toContain("new Worker");
    expect(source("src/workers/board-solver.worker.ts")).toContain(
      "GENERATED_DICTIONARY_BUCKETS",
    );
  });
});
