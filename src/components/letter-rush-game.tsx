"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_BOARD } from "@/game/board";
import { isDictionaryWord } from "@/game/dictionary";
import { wordNoticeDuration } from "@/game/interaction";
import {
  calculateWordScore,
  createWordFromPath,
  isDuplicateWord,
  validateTilePath,
} from "@/game/logic";
import { LEGACY_RULESET, type GameRuleset } from "@/game/ruleset";
import type {
  LetterBoard,
  ScoredWordSubmission,
  TilePath,
  WordPathSubmission,
} from "@/game/types";
import { useWordOpportunities } from "@/hooks/use-word-opportunities";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";

import { AppHeader } from "./app-header";
import {
  LetterBoard as LetterBoardSurface,
  type WordNotice,
} from "./letter-board";
import styles from "./letter-rush-game.module.css";
import { WordOpportunities } from "./word-opportunities";

const GAME_LENGTH_SECONDS = 60;

type GamePhase = "ready" | "playing" | "finished";
type AccessibilityStatus = string;

export type LetterRushGameProps = {
  board?: LetterBoard;
  mode?: "single" | "solo" | "multiplayer";
  roundDurationSeconds?: number;
  scheduledStartAt?: string | null;
  serverClockOffsetMs?: number;
  initialSubmissions?: readonly ScoredWordSubmission[];
  onProgress?: (submissions: readonly ScoredWordSubmission[]) => void;
  onRoundComplete?: (
    submissions: readonly WordPathSubmission[],
  ) => void | Promise<void>;
  onPlayAgain?: () => void;
  onRetryResult?: () => void;
  onExit?: () => boolean | void | Promise<boolean | void>;
  onExitHandlesConfirmation?: boolean;
  onReturnToMenu?: () => void;
  ruleset?: GameRuleset;
  connectionStatus?: string;
  resultStatus?: "idle" | "saving" | "saved" | "error";
  analysisMatchId?: string | null;
  analysisSupabase?: BrowserSupabaseClient | null;
};

function toPathSubmissions(
  submissions: readonly ScoredWordSubmission[],
): WordPathSubmission[] {
  return submissions.map(({ word, path }) => ({ word, path }));
}

function formatScore(value: number): string {
  return value.toLocaleString("en-US");
}

function formatScoreboardScore(value: number): string {
  return Math.max(0, value).toString().padStart(4, "0");
}

function formatTimer(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes.toString().padStart(2, "0")}:${(safeSeconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

function triggerAcceptedWordHaptic(): void {
  if (typeof navigator.vibrate !== "function") return;

  // Submission runs only after pointer release. Keep the pulse short so it
  // confirms an accepted word without competing with the next swipe.
  navigator.vibrate(12);
}

export function LetterRushGame({
  board = DEFAULT_BOARD,
  mode = "single",
  roundDurationSeconds = GAME_LENGTH_SECONDS,
  scheduledStartAt = null,
  serverClockOffsetMs = 0,
  initialSubmissions = [],
  onProgress,
  onRoundComplete,
  onPlayAgain,
  onRetryResult,
  onExit,
  onExitHandlesConfirmation = false,
  onReturnToMenu,
  ruleset = LEGACY_RULESET,
  connectionStatus,
  resultStatus = "idle",
  analysisMatchId = null,
  analysisSupabase = null,
}: LetterRushGameProps) {
  const isMultiplayer = mode === "multiplayer";
  const isSolo = mode === "solo";
  const isServerRound = mode !== "single";
  const [phase, setPhase] = useState<GamePhase>(
    isServerRound ? "playing" : "ready",
  );
  const [secondsLeft, setSecondsLeft] = useState(roundDurationSeconds);
  const [acceptedWords, setAcceptedWords] = useState<ScoredWordSubmission[]>(
    () => [...initialSubmissions],
  );
  const [score, setScore] = useState(() =>
    initialSubmissions.reduce((total, entry) => total + entry.score, 0),
  );
  const [accessibilityStatus, setAccessibilityStatus] =
    useState<AccessibilityStatus>(
      isServerRound
        ? "The server-timed round is live."
        : "Connect neighboring letters. Release to submit.",
    );
  const [wordNotice, setWordNotice] = useState<WordNotice | null>(null);
  const [isExitPending, setIsExitPending] = useState(false);

  const acceptedWordsRef = useRef<ScoredWordSubmission[]>([
    ...initialSubmissions,
  ]);
  const deadlineRef = useRef(0);
  const roundFinishedRef = useRef(false);
  const pendingWordsRef = useRef(new Set<string>());
  const pendingChecksRef = useRef(new Set<Promise<void>>());
  const noticeCounterRef = useRef(0);
  const noticeTimeoutRef = useRef<number | null>(null);
  const suppressCompletionRef = useRef(false);
  const exitRequestRef = useRef<() => Promise<boolean>>(async () => false);

  const geometry = useMemo(
    () => ({
      rows: ruleset.rows,
      columns: ruleset.columns,
      activeCells: ruleset.activeCells,
    }),
    [ruleset],
  );
  const acceptedWordNames = useMemo(
    () => acceptedWords.map((entry) => entry.word),
    [acceptedWords],
  );
  const opportunities = useWordOpportunities(
    board,
    ruleset,
    acceptedWordNames,
    phase === "finished" &&
      !isMultiplayer &&
      (!isSolo || resultStatus === "saved"),
    analysisSupabase,
    analysisMatchId,
  );
  const boardKey = useMemo(
    () =>
      board
        .flat()
        .map((letter) => letter ?? "_")
        .join(""),
    [board],
  );
  const sortedAcceptedWords = [...acceptedWords].sort(
    (first, second) =>
      second.score - first.score ||
      second.word.length - first.word.length ||
      first.word.localeCompare(second.word),
  );
  const bestWord = acceptedWords.reduce<ScoredWordSubmission | null>(
    (best, entry) => {
      if (!best || entry.score > best.score) return entry;
      if (entry.score === best.score && entry.word.length > best.word.length) {
        return entry;
      }
      return best;
    },
    null,
  );

  const clearWordNotice = useCallback(() => {
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = null;
    }
    setWordNotice(null);
  }, []);

  const showWordNotice = useCallback(
    (kind: WordNotice["kind"], message: string) => {
      clearWordNotice();
      noticeCounterRef.current += 1;
      setWordNotice({ id: noticeCounterRef.current, kind, message });
      noticeTimeoutRef.current = window.setTimeout(() => {
        noticeTimeoutRef.current = null;
        setWordNotice(null);
      }, wordNoticeDuration(kind));
    },
    [clearWordNotice],
  );

  useEffect(() => () => clearWordNotice(), [clearWordNotice]);

  const finishGame = useCallback(() => {
    if (roundFinishedRef.current || suppressCompletionRef.current) return;

    roundFinishedRef.current = true;
    clearWordNotice();
    setSecondsLeft(0);
    setPhase("finished");
    void Promise.all([...pendingChecksRef.current]).then(() => {
      if (!suppressCompletionRef.current) {
        onRoundComplete?.(toPathSubmissions(acceptedWordsRef.current));
      }
    });
  }, [clearWordNotice, onRoundComplete]);

  useEffect(() => {
    if (phase !== "playing" || isExitPending) return;

    if (isServerRound && scheduledStartAt) {
      deadlineRef.current =
        Date.parse(scheduledStartAt) + roundDurationSeconds * 1_000;
    } else if (deadlineRef.current === 0) {
      deadlineRef.current = Date.now() + roundDurationSeconds * 1_000;
    }

    const updateTimer = () => {
      const authoritativeNow =
        Date.now() + (isServerRound ? serverClockOffsetMs : 0);
      const nextSeconds = Math.max(
        0,
        Math.ceil((deadlineRef.current - authoritativeNow) / 1_000),
      );
      setSecondsLeft(nextSeconds);
      if (nextSeconds === 0) finishGame();
    };

    const intervalId = window.setInterval(updateTimer, 200);
    updateTimer();
    return () => window.clearInterval(intervalId);
  }, [
    finishGame,
    isExitPending,
    isServerRound,
    phase,
    roundDurationSeconds,
    scheduledStartAt,
    serverClockOffsetMs,
  ]);

  function startGame() {
    clearWordNotice();
    acceptedWordsRef.current = [];
    pendingWordsRef.current.clear();
    pendingChecksRef.current.clear();
    setAcceptedWords([]);
    setScore(0);
    setSecondsLeft(roundDurationSeconds);
    setAccessibilityStatus("Go! Drag across neighboring letters.");
    deadlineRef.current = Date.now() + roundDurationSeconds * 1_000;
    roundFinishedRef.current = false;
    suppressCompletionRef.current = false;
    setIsExitPending(false);
    setPhase("playing");
  }

  async function submitPath(path: TilePath) {
    const pathValidation = validateTilePath(path, geometry);
    if (!pathValidation.isValid) {
      setAccessibilityStatus("That path was not accepted.");
      return;
    }

    const word = createWordFromPath(board, path);
    if (word.length < ruleset.minimumWordLength) {
      setAccessibilityStatus("That path was incomplete.");
      return;
    }

    const acceptedWordNames = acceptedWordsRef.current.map(
      (entry) => entry.word,
    );
    if (
      pendingWordsRef.current.has(word) ||
      isDuplicateWord(word, acceptedWordNames)
    ) {
      showWordNotice("duplicate", `${word} — ALREADY FOUND`);
      setAccessibilityStatus(`${word} was already found.`);
      return;
    }

    pendingWordsRef.current.add(word);
    try {
      if (!(await isDictionaryWord(word))) {
        setAccessibilityStatus(`${word} was not accepted.`);
        return;
      }

      if (
        isDuplicateWord(
          word,
          acceptedWordsRef.current.map((entry) => entry.word),
        )
      ) {
        showWordNotice("duplicate", `${word} — ALREADY FOUND`);
        setAccessibilityStatus(`${word} was already found.`);
        return;
      }

      const wordScore = calculateWordScore(word);
      const nextWords = [
        ...acceptedWordsRef.current,
        { word, path: [...path], score: wordScore },
      ];
      acceptedWordsRef.current = nextWords;
      setAcceptedWords(nextWords);
      setScore((total) => total + wordScore);
      onProgress?.(nextWords);
      showWordNotice("accepted", `${word} (+${formatScore(wordScore)})`);
      setAccessibilityStatus(`${word} accepted for ${wordScore} points.`);
      triggerAcceptedWordHaptic();
    } catch {
      setAccessibilityStatus(
        "The dictionary could not load. Reconnect and try again.",
      );
    } finally {
      pendingWordsRef.current.delete(word);
    }
  }

  function queuePathSubmission(path: TilePath) {
    const pending = submitPath(path);
    pendingChecksRef.current.add(pending);
    void pending.finally(() => pendingChecksRef.current.delete(pending));
  }

  function showDuplicateNotice(word: string) {
    showWordNotice("duplicate", `${word} — ALREADY FOUND`);
    setAccessibilityStatus(`${word} was already found.`);
  }

  async function requestExit(): Promise<boolean> {
    if (!onExit) return false;
    if (
      !onExitHandlesConfirmation &&
      !window.confirm(
        isSolo
          ? "Exit this round? Your partial score and words will not be saved."
          : "Leave this active match? The server will record your departure.",
      )
    ) {
      return false;
    }

    clearWordNotice();
    suppressCompletionRef.current = true;
    roundFinishedRef.current = true;
    setIsExitPending(true);
    setAccessibilityStatus(
      isSolo ? "Exiting this round without saving." : "Leaving this match.",
    );

    try {
      const didExit = await onExit();
      if (didExit !== false) return true;
    } catch {
      // The active screen remains mounted so the player can retry.
    }

    suppressCompletionRef.current = false;
    roundFinishedRef.current = false;
    setIsExitPending(false);
    setAccessibilityStatus(
      isSolo
        ? "The round could not be exited. Try again."
        : "The match could not be left. Try again.",
    );
    return false;
  }

  function confirmExitRound() {
    void requestExit();
  }

  useEffect(() => {
    exitRequestRef.current = requestExit;
  });
  const hasExitHandler = Boolean(onExit);
  const shouldGuardHistory =
    phase === "playing" ||
    (phase === "finished" && isSolo && resultStatus !== "saved");
  useEffect(() => {
    if (!isServerRound || !shouldGuardHistory || !hasExitHandler) return;

    const activeUrl = window.location.href;
    if (!window.history.state?.letterRushExitGuard) {
      window.history.pushState({ letterRushExitGuard: true }, "", activeUrl);
    }
    let navigationApproved = false;

    const handleBackNavigation = () => {
      if (navigationApproved) return;
      window.history.pushState({ letterRushExitGuard: true }, "", activeUrl);
      void exitRequestRef.current().then((didExit) => {
        if (!didExit) return;
        navigationApproved = true;
        window.removeEventListener("popstate", handleBackNavigation);
        window.history.go(-2);
      });
    };

    window.addEventListener("popstate", handleBackNavigation);
    return () => {
      window.removeEventListener("popstate", handleBackNavigation);
    };
  }, [hasExitHandler, isServerRound, shouldGuardHistory]);

  if (phase === "finished") {
    return (
      <main className={styles.appShell}>
        <AppHeader
          activeMatch={isSolo && resultStatus !== "saved"}
          onActiveNavigate={onExit ? requestExit : undefined}
        />
        <section className={styles.resultsCard} aria-labelledby="results-title">
          <div className={styles.resultsBurst} aria-hidden="true">
            TIME!
          </div>
          <p className={styles.kicker}>Round complete</p>
          <h1 id="results-title">
            {isMultiplayer ? "Validating..." : "Nice rush."}
          </h1>
          <p className={styles.resultsLead}>
            You found {acceptedWords.length}{" "}
            {acceptedWords.length === 1 ? "word" : "words"} in{" "}
            {roundDurationSeconds} seconds.
          </p>
          <div className={styles.resultsMetrics}>
            <div>
              <span>{isMultiplayer ? "Local score" : "Final score"}</span>
              <strong>{formatScore(score)}</strong>
            </div>
            <div>
              <span>Best word</span>
              <strong>{bestWord?.word ?? "-"}</strong>
            </div>
          </div>
          <div className={styles.resultsWords}>
            {sortedAcceptedWords.length > 0 ? (
              sortedAcceptedWords.map((entry) => (
                <span key={entry.word}>
                  {entry.word}
                  <small>+{formatScore(entry.score)}</small>
                </span>
              ))
            ) : (
              <p>No words this round.</p>
            )}
          </div>
          {!isMultiplayer && (!isSolo || resultStatus === "saved") ? (
            <WordOpportunities
              error={opportunities.error}
              onRetry={opportunities.retry}
              status={opportunities.status}
              words={opportunities.words}
            />
          ) : null}
          {isMultiplayer ? (
            <p className={styles.resultsLead} role="status">
              Your paths are being checked against the shared board.
            </p>
          ) : (
            <>
              {isSolo ? (
                <p className={styles.resultsLead} role="status">
                  {resultStatus === "saved"
                    ? "Score validated and saved."
                    : resultStatus === "error"
                      ? "Score validation needs another try."
                      : "Validating and saving your score..."}
                </p>
              ) : null}
              {isSolo && resultStatus === "error" ? (
                <button
                  className={styles.primaryButton}
                  onClick={onRetryResult}
                  type="button"
                >
                  Retry result
                </button>
              ) : (
                <button
                  className={styles.primaryButton}
                  disabled={isSolo && resultStatus !== "saved"}
                  onClick={onPlayAgain ?? startGame}
                  type="button"
                >
                  Play again <span aria-hidden="true">↗</span>
                </button>
              )}
            </>
          )}
          {(onReturnToMenu ?? onExit) ? (
            <button
              className={styles.textButton}
              onClick={onReturnToMenu ?? onExit}
              type="button"
            >
              Return to menu
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className={`${styles.appShell} ${styles.activeGameShell}`}>
      <AppHeader
        activeMatch={phase === "playing"}
        onActiveNavigate={onExit ? requestExit : undefined}
      />
      <section className={styles.gameUnit} aria-label="Active game">
        <div className={styles.compactScoreboard} aria-label="Game status">
          <div className={styles.wordCountMetric}>
            <small>Words</small>
            <strong>{acceptedWords.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className={styles.totalScoreMetric}>
            <small>Score</small>
            <strong>{formatScoreboardScore(score)}</strong>
          </div>
          <div
            className={styles.compactTimer}
            role="timer"
            aria-label={`${secondsLeft} seconds remaining`}
          >
            <small>Time</small>
            <strong>{formatTimer(secondsLeft)}</strong>
          </div>
          <div className={styles.compactRoundStatus} role="status">
            <span className={styles.statusDot} aria-hidden="true" />
            <span>
              {connectionStatus ??
                (phase === "playing"
                  ? isMultiplayer
                    ? "Match connected"
                    : "Round live"
                  : `${roundDurationSeconds}-second sprint`)}
            </span>
          </div>
          {phase === "playing" && onExit ? (
            <button
              className={styles.exitRoundButton}
              disabled={isExitPending}
              onClick={confirmExitRound}
              type="button"
            >
              {isExitPending
                ? "Leaving..."
                : isSolo
                  ? "Exit round"
                  : "Leave match"}
            </button>
          ) : null}
        </div>

        <LetterBoardSurface
          acceptedWords={acceptedWordNames}
          board={board}
          interactive={phase === "playing" && !isExitPending}
          key={boardKey}
          notice={wordNotice}
          onDuplicate={showDuplicateNotice}
          onSubmitPath={queuePathSubmission}
          ruleset={ruleset}
        />

        {phase === "ready" ? (
          <button className={styles.startRoundButton} onClick={startGame}>
            Start game <span aria-hidden="true">↗</span>
          </button>
        ) : null}
      </section>

      <div className={styles.srOnly} role="status" aria-live="polite">
        {accessibilityStatus}
      </div>
    </main>
  );
}
