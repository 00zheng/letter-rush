import type { LetterBoard, TileCoordinate, TilePath } from "./types";

export type PathValidationReason =
  "empty-path" | "out-of-bounds" | "repeated-tile" | "non-adjacent-tiles";

export type PathValidationResult =
  { isValid: true } | { isValid: false; reason: PathValidationReason };

function coordinateKey(coordinate: TileCoordinate): string {
  return `${coordinate.row}:${coordinate.column}`;
}

function isCoordinateInBounds(
  coordinate: TileCoordinate,
  boardSize: number,
): boolean {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.column) &&
    coordinate.row >= 0 &&
    coordinate.column >= 0 &&
    coordinate.row < boardSize &&
    coordinate.column < boardSize
  );
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
  boardSize = 4,
): PathValidationResult {
  if (path.length === 0) {
    return { isValid: false, reason: "empty-path" };
  }

  if (
    !Number.isInteger(boardSize) ||
    boardSize <= 0 ||
    path.some((coordinate) => !isCoordinateInBounds(coordinate, boardSize))
  ) {
    return { isValid: false, reason: "out-of-bounds" };
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

      if (typeof letter !== "string") {
        throw new RangeError(`Tile (${row}, ${column}) is outside the board.`);
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
