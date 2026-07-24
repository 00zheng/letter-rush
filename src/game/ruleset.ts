import type { BoardGeometry, TileCoordinate } from "./types";

export const RULESET_VERSION = "2";
export const DICTIONARY_VERSION = "enable2k-af52415-v1";
export const SCORING_RULES_VERSION = "classic-v1";
export const LEGACY_BOARD_GENERATION_VERSION = "legacy-v1";
export const BOARD_GENERATION_VERSION = "weighted-v2";

export const BOARD_SIZE_PRESETS = [4, 5, 6, 8] as const;
export const ROUND_DURATION_OPTIONS = [30, 60, 90, 120, 180] as const;
export const MINIMUM_ACTIVE_CELLS = 9;
export const MINIMUM_BOARD_DIMENSION = 3;
export const MAXIMUM_BOARD_DIMENSION = 8;

export type BoardShape = "rectangle" | "diamond" | "cross" | "custom";
export type BoardGenerationVersion =
  typeof LEGACY_BOARD_GENERATION_VERSION | typeof BOARD_GENERATION_VERSION;

export type GameRuleset = BoardGeometry &
  Readonly<{
    version: typeof RULESET_VERSION;
    shape: BoardShape;
    roundDurationSeconds: (typeof ROUND_DURATION_OPTIONS)[number];
    minimumWordLength: number;
    dictionaryVersion: string;
    scoringRulesVersion: typeof SCORING_RULES_VERSION;
    boardGenerationVersion: BoardGenerationVersion;
  }>;

export type RulesetValidation =
  { isValid: true; ruleset: GameRuleset } | { isValid: false; message: string };

export function coordinateIndex(
  coordinate: TileCoordinate,
  columns: number,
): number {
  return coordinate.row * columns + coordinate.column;
}

export function isCoordinateActive(
  geometry: BoardGeometry,
  coordinate: TileCoordinate,
): boolean {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.column) &&
    coordinate.row >= 0 &&
    coordinate.column >= 0 &&
    coordinate.row < geometry.rows &&
    coordinate.column < geometry.columns &&
    geometry.activeCells[coordinateIndex(coordinate, geometry.columns)] === true
  );
}

export function createShapeMask(
  rows: number,
  columns: number,
  shape: Exclude<BoardShape, "custom">,
): boolean[] {
  if (shape === "rectangle") {
    return Array.from({ length: rows * columns }, () => true);
  }

  const centerRow = (rows - 1) / 2;
  const centerColumn = (columns - 1) / 2;

  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;

    if (shape === "cross") {
      const rowDistance = Math.abs(row - centerRow);
      const columnDistance = Math.abs(column - centerColumn);
      return rowDistance <= 0.5 || columnDistance <= 0.5;
    }

    const normalizedRowDistance =
      Math.abs(row - centerRow) / Math.max(centerRow, 0.5);
    const normalizedColumnDistance =
      Math.abs(column - centerColumn) / Math.max(centerColumn, 0.5);
    return normalizedRowDistance + normalizedColumnDistance <= 1.15;
  });
}

export function areActiveCellsConnected(geometry: BoardGeometry): boolean {
  const firstActiveIndex = geometry.activeCells.findIndex(Boolean);
  if (firstActiveIndex === -1) return false;

  const visited = new Set<number>([firstActiveIndex]);
  const queue = [firstActiveIndex];

  while (queue.length > 0) {
    const currentIndex = queue.shift()!;
    const currentRow = Math.floor(currentIndex / geometry.columns);
    const currentColumn = currentIndex % geometry.columns;

    for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
      for (let columnDelta = -1; columnDelta <= 1; columnDelta += 1) {
        if (rowDelta === 0 && columnDelta === 0) continue;

        const row = currentRow + rowDelta;
        const column = currentColumn + columnDelta;
        if (
          row < 0 ||
          column < 0 ||
          row >= geometry.rows ||
          column >= geometry.columns
        ) {
          continue;
        }

        const neighborIndex = row * geometry.columns + column;
        if (
          geometry.activeCells[neighborIndex] &&
          !visited.has(neighborIndex)
        ) {
          visited.add(neighborIndex);
          queue.push(neighborIndex);
        }
      }
    }
  }

  return visited.size === geometry.activeCells.filter(Boolean).length;
}

function isSupportedDuration(
  value: number,
): value is (typeof ROUND_DURATION_OPTIONS)[number] {
  return ROUND_DURATION_OPTIONS.includes(
    value as (typeof ROUND_DURATION_OPTIONS)[number],
  );
}

export function validateRuleset(value: unknown): RulesetValidation {
  if (!value || typeof value !== "object") {
    return { isValid: false, message: "A ruleset object is required." };
  }

  const candidate = value as Partial<GameRuleset>;
  const rows = candidate.rows;
  const columns = candidate.columns;

  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows! < MINIMUM_BOARD_DIMENSION ||
    rows! > MAXIMUM_BOARD_DIMENSION ||
    columns! < MINIMUM_BOARD_DIMENSION ||
    columns! > MAXIMUM_BOARD_DIMENSION
  ) {
    return {
      isValid: false,
      message: "Board rows and columns must be whole numbers from 3 through 8.",
    };
  }

  if (
    !Array.isArray(candidate.activeCells) ||
    candidate.activeCells.length !== rows! * columns! ||
    candidate.activeCells.some((cell) => typeof cell !== "boolean")
  ) {
    return {
      isValid: false,
      message: "The active-cell mask must contain one boolean per board cell.",
    };
  }

  const activeCells = [...candidate.activeCells];
  if (activeCells.filter(Boolean).length < MINIMUM_ACTIVE_CELLS) {
    return {
      isValid: false,
      message: `A board needs at least ${MINIMUM_ACTIVE_CELLS} active cells.`,
    };
  }

  if (
    !areActiveCellsConnected({
      rows: rows!,
      columns: columns!,
      activeCells,
    })
  ) {
    return {
      isValid: false,
      message: "All active cells must form one connected shape.",
    };
  }

  if (
    !Number.isInteger(candidate.roundDurationSeconds) ||
    !isSupportedDuration(candidate.roundDurationSeconds!)
  ) {
    return {
      isValid: false,
      message: "Choose a supported round duration from 30 to 180 seconds.",
    };
  }

  if (
    !Number.isInteger(candidate.minimumWordLength) ||
    candidate.minimumWordLength! < 3 ||
    candidate.minimumWordLength! > 8
  ) {
    return {
      isValid: false,
      message: "Minimum word length must be from 3 through 8.",
    };
  }

  if (
    candidate.version !== RULESET_VERSION ||
    candidate.dictionaryVersion !== DICTIONARY_VERSION ||
    candidate.scoringRulesVersion !== SCORING_RULES_VERSION ||
    ![LEGACY_BOARD_GENERATION_VERSION, BOARD_GENERATION_VERSION].includes(
      candidate.boardGenerationVersion as BoardGenerationVersion,
    )
  ) {
    return {
      isValid: false,
      message: "The ruleset uses an unsupported rules or dictionary version.",
    };
  }

  const shape = candidate.shape;
  if (
    shape !== "rectangle" &&
    shape !== "diamond" &&
    shape !== "cross" &&
    shape !== "custom"
  ) {
    return { isValid: false, message: "The board shape is unsupported." };
  }

  if (
    candidate.boardGenerationVersion === LEGACY_BOARD_GENERATION_VERSION &&
    (rows !== 4 || columns !== 4 || activeCells.some((cell) => !cell))
  ) {
    return {
      isValid: false,
      message: "Legacy board generation supports only a full 4 by 4 board.",
    };
  }

  return {
    isValid: true,
    ruleset: {
      version: RULESET_VERSION,
      rows: rows!,
      columns: columns!,
      activeCells,
      shape,
      roundDurationSeconds: candidate.roundDurationSeconds!,
      minimumWordLength: candidate.minimumWordLength!,
      dictionaryVersion: DICTIONARY_VERSION,
      scoringRulesVersion: SCORING_RULES_VERSION,
      boardGenerationVersion: candidate.boardGenerationVersion!,
    },
  };
}

export function createRuleset(
  rows = 4,
  columns = rows,
  shape: BoardShape = "rectangle",
  roundDurationSeconds: (typeof ROUND_DURATION_OPTIONS)[number] = 60,
): GameRuleset {
  const activeCells =
    shape === "custom"
      ? createShapeMask(rows, columns, "rectangle")
      : createShapeMask(rows, columns, shape);
  const validation = validateRuleset({
    version: RULESET_VERSION,
    rows,
    columns,
    activeCells,
    shape,
    roundDurationSeconds,
    minimumWordLength: 3,
    dictionaryVersion: DICTIONARY_VERSION,
    scoringRulesVersion: SCORING_RULES_VERSION,
    boardGenerationVersion: BOARD_GENERATION_VERSION,
  });

  if (!validation.isValid) {
    throw new RangeError(validation.message);
  }

  return validation.ruleset;
}

export const DEFAULT_RULESET = createRuleset();

export const LEGACY_RULESET: GameRuleset = {
  ...DEFAULT_RULESET,
  version: RULESET_VERSION,
  boardGenerationVersion: LEGACY_BOARD_GENERATION_VERSION,
};

export function serializeRuleset(ruleset: GameRuleset): string {
  return JSON.stringify({
    version: ruleset.version,
    rows: ruleset.rows,
    columns: ruleset.columns,
    activeCells: ruleset.activeCells,
    shape: ruleset.shape,
    roundDurationSeconds: ruleset.roundDurationSeconds,
    minimumWordLength: ruleset.minimumWordLength,
    dictionaryVersion: ruleset.dictionaryVersion,
    scoringRulesVersion: ruleset.scoringRulesVersion,
    boardGenerationVersion: ruleset.boardGenerationVersion,
  });
}
