import { isCoordinateActive } from "./ruleset";
import type {
  BoardGeometry,
  LetterBoard,
  TileCoordinate,
  TilePath,
} from "./types";

export type PathValidationReason =
  | "empty-path"
  | "out-of-bounds"
  | "inactive-tile"
  | "repeated-tile"
  | "non-adjacent-tiles";

export type PathValidationResult =
  { isValid: true } | { isValid: false; reason: PathValidationReason };

function coordinateKey(coordinate: TileCoordinate): string {
  return `${coordinate.row}:${coordinate.column}`;
}

function isCoordinateInBounds(
  coordinate: TileCoordinate,
  geometry: Pick<BoardGeometry, "rows" | "columns">,
): boolean {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.column) &&
    coordinate.row >= 0 &&
    coordinate.column >= 0 &&
    coordinate.row < geometry.rows &&
    coordinate.column < geometry.columns
  );
}

function normalizeGeometry(
  geometryOrBoardSize: BoardGeometry | number,
): BoardGeometry {
  if (typeof geometryOrBoardSize === "number") {
    return {
      rows: geometryOrBoardSize,
      columns: geometryOrBoardSize,
      activeCells: Array.from(
        { length: geometryOrBoardSize * geometryOrBoardSize },
        () => true,
      ),
    };
  }

  return geometryOrBoardSize;
}

/**
 * Returns true when two different tiles touch by an edge or a corner.
 */
export function areCoordinatesAdjacent(
  first: TileCoordinate,
  second: TileCoordinate,
): boolean {
  const rowDistance = Math.abs(first.row - second.row);
  const columnDistance = Math.abs(first.column - second.column);

  return (
    (rowDistance !== 0 || columnDistance !== 0) &&
    rowDistance <= 1 &&
    columnDistance <= 1
  );
}

export function hasRepeatedTiles(path: TilePath): boolean {
  const seenTiles = new Set<string>();

  for (const coordinate of path) {
    const key = coordinateKey(coordinate);

    if (seenTiles.has(key)) {
      return true;
    }

    seenTiles.add(key);
  }

  return false;
}

/**
 * Validates board bounds, repeated tiles, and every transition in a path.
 * Word-length and dictionary checks belong to submission validation.
 */
export function validateTilePath(
  path: TilePath,
  geometryOrBoardSize: BoardGeometry | number = 4,
): PathValidationResult {
  const geometry = normalizeGeometry(geometryOrBoardSize);

  if (path.length === 0) {
    return { isValid: false, reason: "empty-path" };
  }

  if (
    !Number.isInteger(geometry.rows) ||
    !Number.isInteger(geometry.columns) ||
    geometry.rows <= 0 ||
    geometry.columns <= 0 ||
    geometry.activeCells.length !== geometry.rows * geometry.columns ||
    path.some((coordinate) => !isCoordinateInBounds(coordinate, geometry))
  ) {
    return { isValid: false, reason: "out-of-bounds" };
  }

  if (path.some((coordinate) => !isCoordinateActive(geometry, coordinate))) {
    return { isValid: false, reason: "inactive-tile" };
  }

  if (hasRepeatedTiles(path)) {
    return { isValid: false, reason: "repeated-tile" };
  }

  for (let index = 1; index < path.length; index += 1) {
    if (!areCoordinatesAdjacent(path[index - 1], path[index])) {
      return { isValid: false, reason: "non-adjacent-tiles" };
    }
  }

  return { isValid: true };
}

export function createWordFromPath(board: LetterBoard, path: TilePath): string {
  return path
    .map(({ row, column }) => {
      const letter = board[row]?.[column];

      if (typeof letter !== "string" || letter.length === 0) {
        throw new RangeError(
          `Tile (${row}, ${column}) is outside the active board.`,
        );
      }

      return letter;
    })
    .join("")
    .toUpperCase();
}

export function calculateWordScore(word: string): number {
  const length = word.trim().length;

  if (length < 3) return 0;
  if (length === 3) return 100;
  if (length === 4) return 400;
  if (length === 5) return 800;
  if (length === 6) return 1_400;
  if (length === 7) return 1_800;

  return 2_200;
}

/**
 * Duplicate detection is case-insensitive and ignores surrounding whitespace.
 */
export function isDuplicateWord(
  word: string,
  submittedWords: Iterable<string>,
): boolean {
  const normalizedWord = word.trim().toUpperCase();

  for (const submittedWord of submittedWords) {
    if (submittedWord.trim().toUpperCase() === normalizedWord) {
      return true;
    }
  }

  return false;
}
