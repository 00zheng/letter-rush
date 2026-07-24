"use client";

import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { calculateBoardLayout } from "@/game/board-layout";
import {
  isDictionaryWordCached,
  preloadDictionaryBuckets,
} from "@/game/dictionary";
import {
  advanceTilePath,
  cancelTilePath,
  deriveLiveSelectionFeedback,
  interpolatePointerSegment,
  TERMINAL_SELECTION_FLASH_MS,
} from "@/game/interaction";
import {
  createWordFromPath,
  isDuplicateWord,
  validateTilePath,
} from "@/game/logic";
import type { GameRuleset } from "@/game/ruleset";
import type {
  LetterBoard as LetterBoardGrid,
  TileCoordinate,
  TilePath,
} from "@/game/types";

import styles from "./letter-rush-game.module.css";

type SelectionState = "neutral" | "valid" | "duplicate";
type SelectionCandidate = {
  message:
    "Keep building" | "Valid word" | "Already found" | "Not in dictionary";
  state: SelectionState;
  word: string;
};

export type WordNotice = {
  id: number;
  kind: "accepted" | "duplicate";
  message: string;
};

type LetterBoardProps = {
  acceptedWords: readonly string[];
  board: LetterBoardGrid;
  interactive: boolean;
  notice: WordNotice | null;
  onDuplicate: (word: string) => void;
  onSubmitPath: (path: TilePath) => void;
  ruleset: GameRuleset;
};

const EMPTY_CANDIDATE: SelectionCandidate = {
  message: "Keep building",
  state: "neutral",
  word: "",
};

function matches(first: TileCoordinate, second: TileCoordinate): boolean {
  return first.row === second.row && first.column === second.column;
}

function pathsMatch(
  first: readonly TileCoordinate[],
  second: readonly TileCoordinate[],
): boolean {
  return (
    first.length === second.length &&
    first.every((tile, index) => matches(tile, second[index]))
  );
}

function coordinateFromTile(element: Element | null): TileCoordinate | null {
  const tile = element?.closest<HTMLElement>("[data-board-tile='true']");
  if (!tile) return null;

  const row = Number(tile.dataset.row);
  const column = Number(tile.dataset.column);
  return Number.isInteger(row) && Number.isInteger(column)
    ? { row, column }
    : null;
}

function LetterBoardSurface({
  acceptedWords,
  board,
  interactive,
  notice,
  onDuplicate,
  onSubmitPath,
  ruleset,
}: LetterBoardProps) {
  const [dictionaryReady, setDictionaryReady] = useState(false);
  const [selectedPath, setSelectedPath] = useState<TileCoordinate[]>([]);
  const [selection, setSelection] =
    useState<SelectionCandidate>(EMPTY_CANDIDATE);
  const [isDragging, setIsDragging] = useState(false);
  const [boardLayout, setBoardLayout] = useState(() =>
    calculateBoardLayout(288, ruleset.rows, ruleset.columns),
  );
  const [pathOverlay, setPathOverlay] = useState({
    width: 1,
    height: 1,
    points: "",
  });

  const boardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const acceptedWordsRef = useRef(acceptedWords);
  const candidateRef = useRef<SelectionCandidate>(EMPTY_CANDIDATE);
  const lastPointerPoint = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  const locallySubmittedWordsRef = useRef(new Set<string>());
  const selectedPathRef = useRef<TileCoordinate[]>([]);
  const terminalClearFrameRef = useRef<number | null>(null);
  const terminalClearSecondFrameRef = useRef<number | null>(null);
  const terminalClearTimeoutRef = useRef<number | null>(null);

  const geometry = useMemo(
    () => ({
      rows: ruleset.rows,
      columns: ruleset.columns,
      activeCells: ruleset.activeCells,
    }),
    [ruleset],
  );

  useEffect(() => {
    acceptedWordsRef.current = acceptedWords;
    for (const word of locallySubmittedWordsRef.current) {
      if (isDuplicateWord(word, acceptedWords)) {
        locallySubmittedWordsRef.current.delete(word);
      }
    }
  }, [acceptedWords]);

  const clearTerminalSchedule = useCallback(() => {
    if (terminalClearFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalClearFrameRef.current);
      terminalClearFrameRef.current = null;
    }
    if (terminalClearSecondFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalClearSecondFrameRef.current);
      terminalClearSecondFrameRef.current = null;
    }
    if (terminalClearTimeoutRef.current !== null) {
      window.clearTimeout(terminalClearTimeoutRef.current);
      terminalClearTimeoutRef.current = null;
    }
  }, []);

  const evaluateSelection = useCallback(
    (path: TilePath): SelectionCandidate => {
      if (!validateTilePath(path, geometry).isValid) return EMPTY_CANDIDATE;

      const word = createWordFromPath(board, path);
      const duplicate =
        locallySubmittedWordsRef.current.has(word) ||
        isDuplicateWord(word, acceptedWordsRef.current);
      const dictionaryMatch = isDictionaryWordCached(word);
      const feedback = deriveLiveSelectionFeedback({
        wordLength: word.length,
        minimumWordLength: ruleset.minimumWordLength,
        isDictionaryWord: dictionaryMatch === true,
        isDuplicate: dictionaryMatch === true && duplicate,
      });

      return {
        message: feedback.message,
        state: feedback.tileState,
        word,
      };
    },
    [board, geometry, ruleset.minimumWordLength],
  );

  const updateSelectedPath = useCallback(
    (path: TileCoordinate[]) => {
      const candidate = path.length ? evaluateSelection(path) : EMPTY_CANDIDATE;
      selectedPathRef.current = path;
      candidateRef.current = candidate;
      setSelectedPath(path);
      setSelection(candidate);
    },
    [evaluateSelection],
  );

  const cancelActiveSelection = useCallback(() => {
    clearTerminalSchedule();
    const pointerId = activePointerId.current;
    const boardElement = boardRef.current;
    activePointerId.current = null;
    lastPointerPoint.current = null;

    if (pointerId !== null && boardElement?.hasPointerCapture(pointerId)) {
      boardElement.releasePointerCapture(pointerId);
    }

    selectedPathRef.current = cancelTilePath();
    candidateRef.current = EMPTY_CANDIDATE;
    setSelectedPath([]);
    setSelection(EMPTY_CANDIDATE);
    setIsDragging(false);
  }, [clearTerminalSchedule]);

  useEffect(() => {
    let active = true;

    void preloadDictionaryBuckets(board.flat()).then(
      () => {
        if (active) setDictionaryReady(true);
      },
      () => {
        if (active) setDictionaryReady(false);
      },
    );

    return () => {
      active = false;
    };
  }, [board]);

  const measureBoard = useCallback(() => {
    const boardElement = boardRef.current;
    const stageElement = stageRef.current;
    if (!boardElement || !stageElement) return;

    const stageRect = stageElement.getBoundingClientRect();
    const layout = calculateBoardLayout(
      stageRect.width,
      ruleset.rows,
      ruleset.columns,
      620,
      stageRect.height,
    );
    setBoardLayout((current) =>
      current.width === layout.width &&
      current.height === layout.height &&
      current.gap === layout.gap &&
      current.tileFontSize === layout.tileFontSize &&
      current.tileRadius === layout.tileRadius &&
      current.lineWidth === layout.lineWidth
        ? current
        : layout,
    );

    const boardRect = boardElement.getBoundingClientRect();
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

    setPathOverlay({
      width: Math.max(1, boardRect.width),
      height: Math.max(1, boardRect.height),
      points,
    });
  }, [ruleset.columns, ruleset.rows]);

  useEffect(() => {
    const stageElement = stageRef.current;
    if (!stageElement) return;

    const observer = new ResizeObserver(measureBoard);
    observer.observe(stageElement);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", measureBoard);
    viewport?.addEventListener("scroll", measureBoard);
    window.addEventListener("orientationchange", cancelActiveSelection);
    window.addEventListener("orientationchange", measureBoard);
    measureBoard();

    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", measureBoard);
      viewport?.removeEventListener("scroll", measureBoard);
      window.removeEventListener("orientationchange", cancelActiveSelection);
      window.removeEventListener("orientationchange", measureBoard);
    };
  }, [cancelActiveSelection, measureBoard]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(measureBoard);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [boardLayout.height, boardLayout.width, measureBoard, selectedPath]);

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

  useEffect(
    () => () => {
      clearTerminalSchedule();
      const pointerId = activePointerId.current;
      if (
        pointerId !== null &&
        boardRef.current?.hasPointerCapture(pointerId)
      ) {
        boardRef.current.releasePointerCapture(pointerId);
      }
    },
    [clearTerminalSchedule],
  );

  const processPointerSamples = useCallback(
    (points: readonly { clientX: number; clientY: number }[]) => {
      const boardElement = boardRef.current;
      if (!boardElement) return;

      const maximumStep = Math.max(
        6,
        boardLayout.width / Math.max(1, ruleset.columns * 2),
      );
      let path = selectedPathRef.current;
      let previous = lastPointerPoint.current;

      for (const point of points) {
        const samples = previous
          ? interpolatePointerSegment(previous, point, maximumStep)
          : [point];
        previous = point;

        for (const sample of samples) {
          const element = document.elementFromPoint(
            sample.clientX,
            sample.clientY,
          );
          const tile = element?.closest("[data-board-tile='true']");
          const coordinate = coordinateFromTile(element);
          if (!coordinate || !tile || !boardElement.contains(tile)) continue;

          const nextPath = advanceTilePath(path, coordinate);
          if (!pathsMatch(path, nextPath)) {
            path = nextPath;
            candidateRef.current = evaluateSelection(path);
          }
        }
      }

      lastPointerPoint.current = previous;
      if (!pathsMatch(selectedPathRef.current, path)) {
        updateSelectedPath(path);
      }
    },
    [boardLayout.width, evaluateSelection, ruleset.columns, updateSelectedPath],
  );

  const scheduleTerminalClear = useCallback(() => {
    clearTerminalSchedule();
    const startedAt = performance.now();
    terminalClearFrameRef.current = window.requestAnimationFrame(() => {
      terminalClearFrameRef.current = null;
      terminalClearSecondFrameRef.current = window.requestAnimationFrame(() => {
        terminalClearSecondFrameRef.current = null;
        const remaining = Math.max(
          0,
          TERMINAL_SELECTION_FLASH_MS - (performance.now() - startedAt),
        );
        terminalClearTimeoutRef.current = window.setTimeout(() => {
          terminalClearTimeoutRef.current = null;
          updateSelectedPath([]);
        }, remaining);
      });
    });
  }, [clearTerminalSchedule, updateSelectedPath]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !interactive ||
      !dictionaryReady ||
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

    clearTerminalSchedule();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    lastPointerPoint.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    updateSelectedPath([coordinate]);
    setIsDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    processPointerSamples(
      coalesced.length > 0
        ? coalesced.map(({ clientX, clientY }) => ({ clientX, clientY }))
        : [{ clientX: event.clientX, clientY: event.clientY }],
    );
  }

  function handlePointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
    shouldSubmit: boolean,
  ) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    if (shouldSubmit) {
      processPointerSamples([
        { clientX: event.clientX, clientY: event.clientY },
      ]);
    }

    const completedPath = selectedPathRef.current;
    const completedCandidate = candidateRef.current;
    activePointerId.current = null;
    lastPointerPoint.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);

    if (!shouldSubmit || !interactive) {
      updateSelectedPath([]);
      return;
    }

    if (completedCandidate.state === "valid") {
      locallySubmittedWordsRef.current.add(completedCandidate.word);
      onSubmitPath(completedPath);
      scheduleTerminalClear();
      return;
    }

    if (completedCandidate.state === "duplicate") {
      onDuplicate(completedCandidate.word);
      scheduleTerminalClear();
      return;
    }

    updateSelectedPath([]);
  }

  const boardStyle = {
    "--board-columns": ruleset.columns,
    "--board-rows": ruleset.rows,
    "--board-gap": `${boardLayout.gap}px`,
    "--tile-font-size": `${boardLayout.tileFontSize}px`,
    "--tile-radius": `${boardLayout.tileRadius}px`,
    "--path-line-width": boardLayout.lineWidth,
    "--path-shadow-width": boardLayout.lineWidth + 7,
    width: `${boardLayout.width}px`,
    height: `${boardLayout.height}px`,
  } as CSSProperties;

  return (
    <section className={styles.boardArea} aria-label="Letter Rush board">
      <div className={styles.wordNoticeSlot} aria-live="polite">
        {notice ? (
          <div
            className={`${styles.wordNotice} ${
              notice.kind === "duplicate"
                ? styles.wordNoticeDuplicate
                : styles.wordNoticeAccepted
            }`}
            key={notice.id}
          >
            {notice.message}
          </div>
        ) : null}
      </div>

      <div className={styles.boardStage} ref={stageRef}>
        <div
          ref={boardRef}
          className={`${styles.board} ${
            !interactive || !dictionaryReady ? styles.boardWaiting : ""
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
              const isSelected = selectedPath.some(
                (coordinate) =>
                  coordinate.row === rowIndex &&
                  coordinate.column === columnIndex,
              );

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
                    } ${
                      isSelected && selection.state === "valid"
                        ? styles.tileValid
                        : ""
                    } ${
                      isSelected && selection.state === "duplicate"
                        ? styles.tileDuplicate
                        : ""
                    }`}
                    data-board-tile="true"
                    data-row={rowIndex}
                    data-column={columnIndex}
                    disabled={!interactive || !dictionaryReady}
                    aria-pressed={isSelected}
                    aria-label={`Row ${rowIndex + 1}, column ${
                      columnIndex + 1
                    }: ${letter}${
                      isSelected ? `, selected, ${selection.message}` : ""
                    }`}
                  >
                    <span className={styles.tileLetter}>{letter}</span>
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
                className={`${styles.pathLine} ${
                  selection.state === "valid"
                    ? styles.pathValid
                    : selection.state === "duplicate"
                      ? styles.pathDuplicate
                      : ""
                }`}
                points={pathOverlay.points}
              />
            </svg>
          ) : null}
        </div>
      </div>

      <div className={styles.srOnly} role="status" aria-live="polite">
        {!dictionaryReady
          ? "Loading the local dictionary."
          : selectedPath.length > 0
            ? selection.message
            : "Ready for a new path."}
      </div>
    </section>
  );
}

export const LetterBoard = memo(LetterBoardSurface);
