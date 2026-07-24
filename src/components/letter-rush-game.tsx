"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DEFAULT_BOARD } from "@/game/board";
import { isDictionaryWord } from "@/game/dictionary";
import {
  areCoordinatesAdjacent,
  calculateWordScore,
  createWordFromPath,
  isDuplicateWord,
  validateTilePath,
} from "@/game/logic";
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
type FeedbackKind = "neutral" | "success" | "error";

type Feedback = {
  kind: FeedbackKind;
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
};

const READY_FEEDBACK: Feedback = {
  kind: "neutral",
  message: "Connect neighboring letters. Release to submit.",
};

function coordinatesMatch(
  first: TileCoordinate,
  second: TileCoordinate,
): boolean {
  return first.row === second.row && first.column === second.column;
}

function coordinateFromTile(element: Element | null): TileCoordinate | null {
  const tile = element?.closest<HTMLElement>("[data-board-tile='true']");

  if (!tile) return null;

  const row = Number(tile.dataset.row);
  const column = Number(tile.dataset.column);

  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;

  return { row, column };
}

function toPathSubmissions(
  submissions: readonly ScoredWordSubmission[],
): WordPathSubmission[] {
  return submissions.map(({ word, path }) => ({ word, path }));
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

  const boardRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const selectedPathRef = useRef<TileCoordinate[]>([]);
  const acceptedWordsRef = useRef<ScoredWordSubmission[]>([
    ...initialSubmissions,
  ]);
  const deadlineRef = useRef(0);
  const roundFinishedRef = useRef(false);

  const currentWord = createWordFromPath(board, selectedPath);

  const pathPoints = selectedPath
    .map(({ row, column }) => `${column * 100 + 50},${row * 100 + 50}`)
    .join(" ");

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

  const cancelActiveSelection = useCallback(() => {
    const pointerId = activePointerId.current;
    const boardElement = boardRef.current;

    if (pointerId !== null && boardElement?.hasPointerCapture(pointerId)) {
      boardElement.releasePointerCapture(pointerId);
    }

    activePointerId.current = null;
    updateSelectedPath([]);
    setIsDragging(false);
  }, [updateSelectedPath]);

  const finishGame = useCallback(() => {
    if (roundFinishedRef.current) return;

    roundFinishedRef.current = true;
    cancelActiveSelection();
    setSecondsLeft(0);
    setPhase("finished");
    onRoundComplete?.(toPathSubmissions(acceptedWordsRef.current));
  }, [cancelActiveSelection, onRoundComplete]);

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

      if (nextSeconds === 0) {
        finishGame();
      }
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

  function submitPath(path: TilePath) {
    const pathValidation = validateTilePath(path, board.length);

    if (!pathValidation.isValid) {
      setFeedback({
        kind: "error",
        message: "That tile path is not valid.",
      });
      return;
    }

    const word = createWordFromPath(board, path);

    if (word.length < 3) {
      setFeedback({
        kind: "error",
        message: `${word || "That"} is too short — use at least 3 letters.`,
      });
      return;
    }

    if (
      isDuplicateWord(
        word,
        acceptedWordsRef.current.map((entry) => entry.word),
      )
    ) {
      setFeedback({
        kind: "error",
        message: `${word} was already found.`,
      });
      return;
    }

    if (!isDictionaryWord(word)) {
      setFeedback({
        kind: "error",
        message: `${word} is not in the practice dictionary.`,
      });
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
      message: `${word} accepted · +${wordScore.toLocaleString()} points`,
    });
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

    if (!coordinate) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    updateSelectedPath([coordinate]);
    setIsDragging(true);
    setFeedback({ kind: "neutral", message: "Keep connecting…" });
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
    const lastCoordinate = path.at(-1);

    if (!lastCoordinate || coordinatesMatch(lastCoordinate, coordinate)) {
      return;
    }

    const previousCoordinate = path.at(-2);

    if (
      previousCoordinate &&
      coordinatesMatch(previousCoordinate, coordinate)
    ) {
      updateSelectedPath(path.slice(0, -1));
      return;
    }

    if (path.some((tile) => coordinatesMatch(tile, coordinate))) return;
    if (!areCoordinatesAdjacent(lastCoordinate, coordinate)) return;

    updateSelectedPath([...path, coordinate]);
  }

  function handlePointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
    shouldSubmit: boolean,
  ) {
    if (activePointerId.current !== event.pointerId) return;

    event.preventDefault();

    const completedPath = selectedPathRef.current;
    const boardElement = event.currentTarget;

    if (boardElement.hasPointerCapture(event.pointerId)) {
      boardElement.releasePointerCapture(event.pointerId);
    }

    activePointerId.current = null;
    updateSelectedPath([]);
    setIsDragging(false);

    if (shouldSubmit && phase === "playing") {
      submitPath(completedPath);
    }
  }

  const timerStyle = {
    "--timer-progress": `${(secondsLeft / roundDurationSeconds) * 360}deg`,
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
            {isMultiplayer ? "Validating…" : "Nice rush."}
          </h1>
          <p className={styles.resultsLead}>
            You found {acceptedWords.length}{" "}
            {acceptedWords.length === 1 ? "word" : "words"} in{" "}
            {roundDurationSeconds} seconds.
          </p>

          <div className={styles.resultsMetrics}>
            <div>
              <span>{isMultiplayer ? "Local score" : "Final score"}</span>
              <strong>{score.toLocaleString()}</strong>
            </div>
            <div>
              <span>Best word</span>
              <strong>{bestWord?.word ?? "—"}</strong>
            </div>
          </div>

          <div className={styles.resultsWords}>
            {acceptedWords.length > 0 ? (
              acceptedWords.map((entry) => (
                <span key={entry.word}>
                  {entry.word}
                  <small>+{entry.score.toLocaleString()}</small>
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
              Play again
              <span aria-hidden="true">↗</span>
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
              {phase === "playing"
                ? isMultiplayer
                  ? "Private match"
                  : "Keep moving"
                : `${roundDurationSeconds}-second sprint`}
            </strong>
          </div>
        </div>

        <div className={styles.scoreMetric}>
          <small>Score</small>
          <strong>{score.toLocaleString()}</strong>
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
            }`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => handlePointerEnd(event, true)}
            onPointerCancel={(event) => handlePointerEnd(event, false)}
            aria-label="4 by 4 letter grid"
          >
            {board.map((row, rowIndex) =>
              row.map((letter, columnIndex) => {
                const selectedIndex = selectedPath.findIndex(
                  (coordinate) =>
                    coordinate.row === rowIndex &&
                    coordinate.column === columnIndex,
                );
                const isSelected = selectedIndex >= 0;

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

            {selectedPath.length > 0 ? (
              <svg
                className={styles.pathLayer}
                viewBox="0 0 400 400"
                aria-hidden="true"
              >
                <polyline className={styles.pathShadow} points={pathPoints} />
                <polyline className={styles.pathLine} points={pathPoints} />
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
                Start game
                <span aria-hidden="true">↗</span>
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
                  <small>+{entry.score.toLocaleString()}</small>
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
