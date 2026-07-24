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

export type PointerSample = { clientX: number; clientY: number };

export const TERMINAL_SELECTION_FLASH_MS = 140;
export const ACCEPTED_WORD_NOTICE_MS = 1_500;
export const DUPLICATE_WORD_NOTICE_MS = 1_000;

export function interpolatePointerSegment(
  from: PointerSample,
  to: PointerSample,
  maximumStep: number,
): PointerSample[] {
  const distance = Math.hypot(
    to.clientX - from.clientX,
    to.clientY - from.clientY,
  );
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, maximumStep)));

  return Array.from({ length: steps }, (_, index) => {
    const progress = (index + 1) / steps;
    return {
      clientX: from.clientX + (to.clientX - from.clientX) * progress,
      clientY: from.clientY + (to.clientY - from.clientY) * progress,
    };
  });
}

export function wordNoticeDuration(kind: "accepted" | "duplicate"): number {
  return kind === "accepted"
    ? ACCEPTED_WORD_NOTICE_MS
    : DUPLICATE_WORD_NOTICE_MS;
}

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
