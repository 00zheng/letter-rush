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
  acquireDirectionalTileCoordinates,
  cancelTilePath,
  deriveLiveSelectionFeedback,
  interpolatePointerSegment,
  minimumAdjacentTileCenterDistance,
  orderPointerSamples,
  POINTER_INTERPOLATION_STEP_RATIO,
  type DirectionalAcquisitionDiagnostic,
  type DirectionalSector,
  type PointerSample,
  type TileHitGeometry,
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
type CachedTileGeometry = TileHitGeometry;

function reportDirectionalDiagnostic(
  event: DirectionalAcquisitionDiagnostic,
): void {
  if (
    process.env.NODE_ENV === "production" ||
    window.localStorage.getItem("letter-rush:diagonal-diagnostics") !== "1"
  ) {
    return;
  }
  console.debug("Letter Rush directional acquisition.", event);
}

const DIRECTIONAL_DIAGNOSTIC =
  process.env.NODE_ENV === "production"
    ? undefined
    : reportDirectionalDiagnostic;

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
    centers: {} as Record<string, { x: number; y: number }>,
  });

  const boardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const acceptedWordsRef = useRef(acceptedWords);
  const candidateRef = useRef<SelectionCandidate>(EMPTY_CANDIDATE);
  const locallySubmittedWordsRef = useRef(new Set<string>());
  const selectedPathRef = useRef<TileCoordinate[]>([]);
  const tileGeometryRef = useRef<{
    maximumSampleStep: number;
    tiles: CachedTileGeometry[];
  }>({ maximumSampleStep: 1, tiles: [] });
  const pointerSegmentRef = useRef<{
    directionalSector: DirectionalSector | null;
    previousSample: PointerSample | null;
  }>({ directionalSector: null, previousSample: null });

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
    const pointerId = activePointerId.current;
    const boardElement = boardRef.current;
    activePointerId.current = null;

    if (pointerId !== null && boardElement?.hasPointerCapture(pointerId)) {
      boardElement.releasePointerCapture(pointerId);
    }

    selectedPathRef.current = cancelTilePath();
    pointerSegmentRef.current = {
      directionalSector: null,
      previousSample: null,
    };
    candidateRef.current = EMPTY_CANDIDATE;
    setSelectedPath([]);
    setSelection(EMPTY_CANDIDATE);
    setIsDragging(false);
  }, []);

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
    const centers: Record<string, { x: number; y: number }> = {};
    const tiles = Array.from(
      boardElement.querySelectorAll<HTMLElement>("[data-board-tile='true']"),
      (tile): CachedTileGeometry | null => {
        const coordinate = coordinateFromTile(tile);
        if (!coordinate) return null;
        const rect = tile.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        centers[`${coordinate.row}:${coordinate.column}`] = {
          x: centerX - boardRect.left,
          y: centerY - boardRect.top,
        };
        return {
          coordinate,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          centerX,
          centerY,
        };
      },
    ).filter((tile): tile is CachedTileGeometry => tile !== null);

    tileGeometryRef.current = {
      maximumSampleStep:
        minimumAdjacentTileCenterDistance(tiles) *
        POINTER_INTERPOLATION_STEP_RATIO,
      tiles,
    };
    setPathOverlay({
      width: Math.max(1, boardRect.width),
      height: Math.max(1, boardRect.height),
      centers,
    });
  }, [ruleset.columns, ruleset.rows]);

  useEffect(() => {
    const stageElement = stageRef.current;
    if (!stageElement) return;

    const observer = new ResizeObserver(measureBoard);
    observer.observe(stageElement);
    if (boardRef.current) observer.observe(boardRef.current);
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
  }, [boardLayout.height, boardLayout.width, measureBoard]);

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
      const pointerId = activePointerId.current;
      if (
        pointerId !== null &&
        boardRef.current?.hasPointerCapture(pointerId)
      ) {
        boardRef.current.releasePointerCapture(pointerId);
      }
    },
    [],
  );

  const processPointerSamples = useCallback(
    (points: readonly PointerSample[]) => {
      if (!boardRef.current) return;
      let path = selectedPathRef.current;
      let previousSample = pointerSegmentRef.current.previousSample;
      let directionalSector = pointerSegmentRef.current.directionalSector;

      for (const rawPoint of orderPointerSamples(points)) {
        if (!previousSample) {
          previousSample = rawPoint;
          continue;
        }
        const interpolated = interpolatePointerSegment(
          previousSample,
          rawPoint,
          tileGeometryRef.current.maximumSampleStep,
        );
        let segmentStart = previousSample;
        for (const point of interpolated) {
          const result = acquireDirectionalTileCoordinates(
            segmentStart,
            point,
            path,
            tileGeometryRef.current.tiles,
            directionalSector,
            DIRECTIONAL_DIAGNOSTIC,
          );
          directionalSector = result.directionalSector;
          for (const coordinate of result.acquired) {
            const nextPath = advanceTilePath(path, coordinate);
            if (!pathsMatch(path, nextPath)) {
              path = nextPath;
              candidateRef.current = evaluateSelection(path);
            }
          }
          segmentStart = point;
        }
        previousSample = rawPoint;
      }
      pointerSegmentRef.current = { directionalSector, previousSample };

      if (!pathsMatch(selectedPathRef.current, path)) {
        updateSelectedPath(path);
      }
    },
    [evaluateSelection, updateSelectedPath],
  );

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

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    pointerSegmentRef.current = {
      directionalSector: null,
      previousSample: {
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      },
    };
    updateSelectedPath([coordinate]);
    setIsDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const samples = coalesced.map(({ clientX, clientY, timeStamp }) => ({
      clientX,
      clientY,
      timeStamp,
    }));
    const lastSample = samples.at(-1);
    if (
      !lastSample ||
      lastSample.clientX !== event.clientX ||
      lastSample.clientY !== event.clientY
    ) {
      samples.push({
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      });
    }
    processPointerSamples(samples);
  }

  function handlePointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
    shouldSubmit: boolean,
  ) {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();

    if (shouldSubmit) {
      processPointerSamples([
        {
          clientX: event.clientX,
          clientY: event.clientY,
          timeStamp: event.timeStamp,
        },
      ]);
    }

    const completedPath = selectedPathRef.current;
    const completedCandidate = candidateRef.current;
    activePointerId.current = null;
    pointerSegmentRef.current = {
      directionalSector: null,
      previousSample: null,
    };
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
      selectedPathRef.current = [];
      candidateRef.current = EMPTY_CANDIDATE;
      setSelectedPath([]);
      setSelection(EMPTY_CANDIDATE);
      onSubmitPath(completedPath);
      return;
    }

    if (completedCandidate.state === "duplicate") {
      onDuplicate(completedCandidate.word);
      selectedPathRef.current = [];
      candidateRef.current = EMPTY_CANDIDATE;
      setSelectedPath([]);
      setSelection(EMPTY_CANDIDATE);
      return;
    }

    updateSelectedPath([]);
  }

  const displayedPath = selectedPath;
  const displayedSelection = selection;
  const displayedPoints = displayedPath
    .map(({ row, column }) => pathOverlay.centers[`${row}:${column}`])
    .filter((center): center is { x: number; y: number } => Boolean(center))
    .map(({ x, y }) => `${x},${y}`)
    .join(" ");

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
              const isSelected = displayedPath.some(
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
                      isSelected && displayedSelection.state === "valid"
                        ? styles.tileValid
                        : ""
                    } ${
                      isSelected && displayedSelection.state === "duplicate"
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
                      isSelected
                        ? `, selected, ${displayedSelection.message}`
                        : ""
                    }`}
                  >
                    <span className={styles.tileLetter}>{letter}</span>
                  </button>
                </div>
              );
            }),
          )}

          <svg
            className={styles.pathLayer}
            viewBox={`0 0 ${pathOverlay.width} ${pathOverlay.height}`}
            aria-hidden="true"
          >
            {displayedPoints ? (
              <>
                <polyline
                  className={styles.pathShadow}
                  points={displayedPoints}
                />
                <polyline
                  className={`${styles.pathLine} ${
                    displayedSelection.state === "valid"
                      ? styles.pathValid
                      : displayedSelection.state === "duplicate"
                        ? styles.pathDuplicate
                        : ""
                  }`}
                  points={displayedPoints}
                />
              </>
            ) : null}
          </svg>
        </div>
      </div>

      <div className={styles.srOnly} role="status" aria-live="polite">
        {!dictionaryReady
          ? "Loading the local dictionary."
          : displayedPath.length > 0
            ? displayedSelection.message
            : "Ready for a new path."}
      </div>
    </section>
  );
}

export const LetterBoard = memo(LetterBoardSurface);
