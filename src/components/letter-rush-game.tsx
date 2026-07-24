"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DEFAULT_BOARD } from "@/game/board";
import { calculateBoardLayout } from "@/game/board-layout";
import { isDictionaryWord } from "@/game/dictionary";
import { advanceTilePath } from "@/game/interaction";
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
  TileCoordinate,
  TilePath,
  WordPathSubmission,
} from "@/game/types";

import { AppHeader } from "./app-header";
import styles from "./letter-rush-game.module.css";

const GAME_LENGTH_SECONDS = 60;

type GamePhase = "ready" | "playing" | "finished";
type Feedback = {
  kind: "neutral" | "success" | "error";
  message: string;
};

export type LetterRushGameProps = {
  board?: LetterBoard;
  mode?: "single" | "multiplayer";
  roundDurationSeconds?: number;
  scheduledStartAt?: string | null;
  serverClockOffsetMs?: number;
  initialSubmissions?: readonly ScoredWordSubmission[];
  onProgress?: (submissions: readonly ScoredWordSubmission[]) => void;
  onRoundComplete?: (submissions: readonly WordPathSubmission[]) => void;
  onExit?: () => void;
  ruleset?: GameRuleset;
  connectionStatus?: string;
};

const READY_FEEDBACK: Feedback = {
  kind: "neutral",
  message: "Connect neighboring letters. Release to submit.",
};

function coordinateFromTile(element: Element | null): TileCoordinate | null {
  const tile = element?.closest<HTMLElement>("[data-board-tile='true']");
  if (!tile) return null;

  const row = Number(tile.dataset.row);
  const column = Number(tile.dataset.column);
  return Number.isInteger(row) && Number.isInteger(column)
    ? { row, column }
    : null;
}

function toPathSubmissions(
  submissions: readonly ScoredWordSubmission[],
): WordPathSubmission[] {
  return submissions.map(({ word, path }) => ({ word, path }));
}

function formatScore(value: number): string {
  return value.toLocaleString("en-US");
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
  onExit,
  ruleset = LEGACY_RULESET,
  connectionStatus,
}: LetterRushGameProps) {
  const isMultiplayer = mode === "multiplayer";
  const [phase, setPhase] = useState<GamePhase>(
    isMultiplayer ? "playing" : "ready",
  );
  const [secondsLeft, setSecondsLeft] = useState(roundDurationSeconds);
  const [selectedPath, setSelectedPath] = useState<TileCoordinate[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [acceptedWords, setAcceptedWords] = useState<ScoredWordSubmission[]>(
    () => [...initialSubmissions],
  );
  const [score, setScore] = useState(() =>
    initialSubmissions.reduce((total, entry) => total + entry.score, 0),
  );
  const [feedback, setFeedback] = useState<Feedback>(
    isMultiplayer
      ? { kind: "neutral", message: "Go! The shared round is live." }
      : READY_FEEDBACK,
  );
  const [boardLayout, setBoardLayout] = useState(() =>
    calculateBoardLayout(288, ruleset.rows, ruleset.columns),
  );
  const [pathOverlay, setPathOverlay] = useState({
    width: 1,
    height: 1,
    points: "",
  });

  const boardRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const selectedPathRef = useRef<TileCoordinate[]>([]);
  const acceptedWordsRef = useRef<ScoredWordSubmission[]>([
    ...initialSubmissions,
  ]);
  const deadlineRef = useRef(0);
  const roundFinishedRef = useRef(false);
  const pendingWordsRef = useRef(new Set<string>());
  const pendingChecksRef = useRef(new Set<Promise<void>>());

  const geometry = useMemo(
    () => ({
      rows: ruleset.rows,
      columns: ruleset.columns,
      activeCells: ruleset.activeCells,
    }),
    [ruleset],
  );
  const currentWord = createWordFromPath(board, selectedPath);
  const newestWords = [...acceptedWords].reverse();
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

  const updateSelectedPath = useCallback((path: TileCoordinate[]) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
  }, []);

  const measureBoard = useCallback(() => {
    const boardElement = boardRef.current;
    if (!boardElement) return;

    const boardRect = boardElement.getBoundingClientRect();
    const layout = calculateBoardLayout(
      boardRect.width,
      ruleset.rows,
      ruleset.columns,
    );
    const points = selectedPathRef.current
      .map(({ row, column }) => {
        const tile = boardElement.querySelector<HTMLElement>(
          `[data-board-tile='true'][data-row='${row}'][data-column='${column}']`,
        );
        if (!tile) return null;
        const tileRect = tile.getBoundingClientRect();
        return `${tileRect.left - boardRect.left + tileRect.width / 2},${
          tileRect.top - boardRect.top + tileRect.height / 2
        }`;
      })
      .filter((point): point is string => point !== null)
      .join(" ");

    setBoardLayout(layout);
    setPathOverlay({
      width: Math.max(1, boardRect.width),
      height: Math.max(1, boardRect.height),
      points,
    });
  }, [ruleset.columns, ruleset.rows]);

  const cancelActiveSelection = useCallback(() => {
    const pointerId = activePointerId.current;
    const boardElement = boardRef.current;
    activePointerId.current = null;

    if (pointerId !== null && boardElement?.hasPointerCapture(pointerId)) {
      boardElement.releasePointerCapture(pointerId);
    }

    updateSelectedPath([]);
    setIsDragging(false);
  }, [updateSelectedPath]);

  const finishGame = useCallback(() => {
    if (roundFinishedRef.current) return;

    roundFinishedRef.current = true;
    cancelActiveSelection();
    setSecondsLeft(0);
    void Promise.all([...pendingChecksRef.current]).then(() => {
      setPhase("finished");
      onRoundComplete?.(toPathSubmissions(acceptedWordsRef.current));
    });
  }, [cancelActiveSelection, onRoundComplete]);

  useEffect(() => {
    const boardElement = boardRef.current;
    if (!boardElement) return;

    const observer = new ResizeObserver(measureBoard);
    observer.observe(boardElement);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", measureBoard);
    viewport?.addEventListener("scroll", measureBoard);
    window.addEventListener("orientationchange", measureBoard);
    measureBoard();

    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", measureBoard);
      viewport?.removeEventListener("scroll", measureBoard);
      window.removeEventListener("orientationchange", measureBoard);
    };
  }, [measureBoard]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(measureBoard);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [measureBoard, selectedPath]);

  useEffect(() => {
    const interrupt = () => cancelActiveSelection();
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") interrupt();
    };

    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [cancelActiveSelection]);

  useEffect(() => {
    if (phase !== "playing") return;

    if (isMultiplayer && scheduledStartAt) {
      deadlineRef.current =
        Date.parse(scheduledStartAt) + roundDurationSeconds * 1_000;
    } else if (deadlineRef.current === 0) {
      deadlineRef.current = Date.now() + roundDurationSeconds * 1_000;
    }

    const updateTimer = () => {
      const authoritativeNow =
        Date.now() + (isMultiplayer ? serverClockOffsetMs : 0);
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
    isMultiplayer,
    phase,
    roundDurationSeconds,
    scheduledStartAt,
    serverClockOffsetMs,
  ]);

  useEffect(() => {
    if (!isDragging) return;

    const previousOverflow = document.body.style.overflow;
    const previousTouchAction = document.body.style.touchAction;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.touchAction = previousTouchAction;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [isDragging]);

  function startGame() {
    cancelActiveSelection();
    acceptedWordsRef.current = [];
    pendingWordsRef.current.clear();
    pendingChecksRef.current.clear();
    setAcceptedWords([]);
    setScore(0);
    setSecondsLeft(roundDurationSeconds);
    setFeedback({
      kind: "neutral",
      message: "Go! Drag across any neighboring letters.",
    });
    deadlineRef.current = Date.now() + roundDurationSeconds * 1_000;
    roundFinishedRef.current = false;
    setPhase("playing");
  }

  async function submitPath(path: TilePath) {
    const pathValidation = validateTilePath(path, geometry);
    if (!pathValidation.isValid) {
      setFeedback({ kind: "error", message: "That tile path is not valid." });
      return;
    }

    const word = createWordFromPath(board, path);
    if (word.length < ruleset.minimumWordLength) {
      setFeedback({
        kind: "error",
        message: `${word || "That"} is too short - use at least ${ruleset.minimumWordLength} letters.`,
      });
      return;
    }

    const acceptedWordNames = acceptedWordsRef.current.map(
      (entry) => entry.word,
    );
    if (
      pendingWordsRef.current.has(word) ||
      isDuplicateWord(word, acceptedWordNames)
    ) {
      setFeedback({ kind: "error", message: `${word} was already found.` });
      return;
    }

    pendingWordsRef.current.add(word);
    try {
      if (!(await isDictionaryWord(word))) {
        setFeedback({
          kind: "error",
          message: `${word} is not in the Letter Rush dictionary.`,
        });
        return;
      }

      if (
        isDuplicateWord(
          word,
          acceptedWordsRef.current.map((entry) => entry.word),
        )
      ) {
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
      setFeedback({
        kind: "success",
        message: `${word} accepted - +${formatScore(wordScore)} points`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message:
          "The dictionary could not load. Reconnect, then submit the word again.",
      });
    } finally {
      pendingWordsRef.current.delete(word);
    }
  }

  function queuePathSubmission(path: TilePath) {
    const pending = submitPath(path);
    pendingChecksRef.current.add(pending);
    void pending.finally(() => pendingChecksRef.current.delete(pending));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      phase !== "playing" ||
      activePointerId.current !== null ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }

    const coordinate = coordinateFromTile(event.target as Element);
    if (
      !coordinate ||
      !ruleset.activeCells[coordinate.row * ruleset.columns + coordinate.column]
    ) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    updateSelectedPath([coordinate]);
    setIsDragging(true);
    setFeedback({ kind: "neutral", message: "Keep connecting..." });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    const elementAtPointer = document.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    const tileAtPointer = elementAtPointer?.closest("[data-board-tile='true']");
    const coordinate = coordinateFromTile(elementAtPointer);
    if (
      !coordinate ||
      !tileAtPointer ||
      !boardRef.current?.contains(tileAtPointer)
    ) {
      return;
    }

    const path = selectedPathRef.current;
    const nextPath = advanceTilePath(path, coordinate);
    if (
      nextPath.length === path.length &&
      nextPath.every(
        (tile, index) =>
          tile.row === path[index]?.row && tile.column === path[index]?.column,
      )
    ) {
      return;
    }
    updateSelectedPath(nextPath);
  }

  function handlePointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
    shouldSubmit: boolean,
  ) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    const completedPath = selectedPathRef.current;
    activePointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateSelectedPath([]);
    setIsDragging(false);

    if (shouldSubmit && phase === "playing") {
      queuePathSubmission(completedPath);
    }
  }

  const timerStyle = {
    "--timer-progress": `${(secondsLeft / roundDurationSeconds) * 360}deg`,
  } as CSSProperties;
  const boardStyle = {
    "--board-columns": ruleset.columns,
    "--board-rows": ruleset.rows,
    "--board-gap": `${boardLayout.gap}px`,
    "--tile-font-size": `${boardLayout.tileFontSize}px`,
    "--tile-radius": `${boardLayout.tileRadius}px`,
    "--path-line-width": boardLayout.lineWidth,
    "--path-shadow-width": boardLayout.lineWidth + 7,
    aspectRatio: `${ruleset.columns} / ${ruleset.rows}`,
  } as CSSProperties;

  if (phase === "finished") {
    return (
      <main className={styles.appShell}>
        <AppHeader />
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
            {acceptedWords.length > 0 ? (
              acceptedWords.map((entry) => (
                <span key={entry.word}>
                  {entry.word}
                  <small>+{formatScore(entry.score)}</small>
                </span>
              ))
            ) : (
              <p>No words this round.</p>
            )}
          </div>
          {isMultiplayer ? (
            <p className={styles.resultsLead} role="status">
              Your paths are being checked against the shared board.
            </p>
          ) : (
            <button className={styles.primaryButton} onClick={startGame}>
              Play again <span aria-hidden="true">↗</span>
            </button>
          )}
          {onExit ? (
            <button
              className={styles.textButton}
              onClick={onExit}
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
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.scoreStrip} aria-label="Game status">
        <div className={styles.roundStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          <div>
            <small>
              {phase === "playing" ? "Round live" : "Ready when you are"}
            </small>
            <strong>
              {connectionStatus ??
                (phase === "playing"
                  ? isMultiplayer
                    ? "Private match"
                    : "Keep moving"
                  : `${roundDurationSeconds}-second sprint`)}
            </strong>
          </div>
        </div>
        <div className={styles.scoreMetric}>
          <small>Score</small>
          <strong>{formatScore(score)}</strong>
        </div>
        <div
          className={styles.timer}
          role="timer"
          aria-label={`${secondsLeft} seconds remaining`}
        >
          <div className={styles.timerRing} style={timerStyle}>
            <span>{secondsLeft}</span>
          </div>
          <small>seconds</small>
        </div>
      </section>

      <div className={styles.workspace}>
        <section className={styles.boardCard} aria-label="Letter Rush board">
          <div className={styles.currentWordPanel}>
            <span>Current word</span>
            <strong aria-live="polite">
              {currentWord || (phase === "playing" ? "DRAG!" : "READY")}
            </strong>
            <small>{selectedPath.length} letters</small>
          </div>

          <div
            ref={boardRef}
            className={`${styles.board} ${
              phase !== "playing" ? styles.boardWaiting : ""
            } ${isDragging ? styles.boardDragging : ""}`}
            style={boardStyle}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
            onLostPointerCapture={() => {
              if (activePointerId.current !== null) cancelActiveSelection();
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => handlePointerEnd(event, true)}
            onPointerCancel={(event) => handlePointerEnd(event, false)}
            aria-label={`${ruleset.rows} by ${ruleset.columns} letter grid`}
          >
            {board.map((row, rowIndex) =>
              row.map((letter, columnIndex) => {
                const selectedIndex = selectedPath.findIndex(
                  (coordinate) =>
                    coordinate.row === rowIndex &&
                    coordinate.column === columnIndex,
                );
                const isSelected = selectedIndex >= 0;

                if (letter === null) {
                  return (
                    <div
                      aria-hidden="true"
                      className={`${styles.tileCell} ${styles.inactiveCell}`}
                      key={`${rowIndex}-${columnIndex}`}
                    />
                  );
                }

                return (
                  <div
                    className={styles.tileCell}
                    key={`${rowIndex}-${columnIndex}`}
                  >
                    <button
                      type="button"
                      className={`${styles.tile} ${
                        isSelected ? styles.tileSelected : ""
                      }`}
                      data-board-tile="true"
                      data-row={rowIndex}
                      data-column={columnIndex}
                      disabled={phase !== "playing"}
                      aria-label={`Row ${rowIndex + 1}, column ${
                        columnIndex + 1
                      }: ${letter}${
                        isSelected ? `, selected ${selectedIndex + 1}` : ""
                      }`}
                    >
                      <span className={styles.tileLetter}>{letter}</span>
                      {isSelected ? (
                        <span className={styles.stepBadge} aria-hidden="true">
                          {selectedIndex + 1}
                        </span>
                      ) : null}
                    </button>
                  </div>
                );
              }),
            )}

            {selectedPath.length > 0 && pathOverlay.points ? (
              <svg
                className={styles.pathLayer}
                viewBox={`0 0 ${pathOverlay.width} ${pathOverlay.height}`}
                aria-hidden="true"
              >
                <polyline
                  className={styles.pathShadow}
                  points={pathOverlay.points}
                />
                <polyline
                  className={styles.pathLine}
                  points={pathOverlay.points}
                />
              </svg>
            ) : null}
          </div>

          <div className={styles.boardFooter}>
            <div
              className={`${styles.feedback} ${styles[feedback.kind]}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true">
                {feedback.kind === "success"
                  ? "✓"
                  : feedback.kind === "error"
                    ? "!"
                    : "↳"}
              </span>
              <p>{feedback.message}</p>
            </div>
            {phase === "ready" ? (
              <button className={styles.primaryButton} onClick={startGame}>
                Start game <span aria-hidden="true">↗</span>
              </button>
            ) : null}
          </div>
        </section>

        <aside className={styles.wordPanel} aria-labelledby="found-words-title">
          <div className={styles.wordPanelHeader}>
            <div>
              <p className={styles.kicker}>Your haul</p>
              <h2 id="found-words-title">Found words</h2>
            </div>
            <span>{acceptedWords.length.toString().padStart(2, "0")}</span>
          </div>
          <div className={styles.wordList}>
            {newestWords.length > 0 ? (
              newestWords.map((entry, index) => (
                <div className={styles.wordRow} key={entry.word}>
                  <span>
                    {String(newestWords.length - index).padStart(2, "0")}
                  </span>
                  <strong>{entry.word}</strong>
                  <small>+{formatScore(entry.score)}</small>
                </div>
              ))
            ) : (
              <div className={styles.emptyWords}>
                <span aria-hidden="true">A→B</span>
                <p>Your accepted words will stack up here.</p>
              </div>
            )}
          </div>
          <div className={styles.scoreKey}>
            <p>Score key</p>
            <div>
              <span>3</span>
              <span>4</span>
              <span>5</span>
              <span>6</span>
              <span>7</span>
              <span>8+</span>
            </div>
            <div>
              <small>100</small>
              <small>400</small>
              <small>800</small>
              <small>1.4k</small>
              <small>1.8k</small>
              <small>2.2k</small>
            </div>
          </div>
        </aside>
      </div>

      <p className={styles.howTo}>
        <span>How to play</span>
        Drag through letters in any direction · no tile repeats · release to
        submit
      </p>
    </main>
  );
}
