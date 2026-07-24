import { areCoordinatesAdjacent } from "./logic";
import type { TileCoordinate, TilePath } from "./types";

function matches(first: TileCoordinate, second: TileCoordinate): boolean {
  return first.row === second.row && first.column === second.column;
}

export function advanceTilePath(
  path: TilePath,
  coordinate: TileCoordinate,
): TileCoordinate[] {
  const last = path.at(-1);
  if (!last) return [coordinate];
  if (matches(last, coordinate)) return [...path];

  const previous = path.at(-2);
  if (previous && matches(previous, coordinate)) {
    return path.slice(0, -1);
  }

  if (path.some((tile) => matches(tile, coordinate))) return [...path];
  if (!areCoordinatesAdjacent(last, coordinate)) return [...path];
  return [...path, coordinate];
}

export function cancelTilePath(): TileCoordinate[] {
  return [];
}

export type LiveSelectionFeedback = {
  tileState: "neutral" | "valid" | "duplicate";
  message:
    "Keep building" | "Valid word" | "Already found" | "Not in dictionary";
};

export function deriveLiveSelectionFeedback(input: {
  wordLength: number;
  minimumWordLength: number;
  isDictionaryWord: boolean;
  isDuplicate: boolean;
}): LiveSelectionFeedback {
  if (input.wordLength < input.minimumWordLength) {
    return { tileState: "neutral", message: "Keep building" };
  }
  if (input.isDuplicate) {
    return { tileState: "duplicate", message: "Already found" };
  }
  if (input.isDictionaryWord) {
    return { tileState: "valid", message: "Valid word" };
  }
  return { tileState: "neutral", message: "Not in dictionary" };
}
