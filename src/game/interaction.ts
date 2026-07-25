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

export type TileHitGeometry = {
  coordinate: TileCoordinate;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

export const TERMINAL_SELECTION_FLASH_MS = 90;
export const ACCEPTED_WORD_NOTICE_MS = 1_500;
export const DUPLICATE_WORD_NOTICE_MS = 1_000;

function segmentEntryProgress(
  from: PointerSample,
  to: PointerSample,
  tile: TileHitGeometry,
): number | null {
  const deltaX = to.clientX - from.clientX;
  const deltaY = to.clientY - from.clientY;
  let entry = 0;
  let exit = 1;

  for (const [origin, delta, minimum, maximum] of [
    [from.clientX, deltaX, tile.left, tile.right],
    [from.clientY, deltaY, tile.top, tile.bottom],
  ] as const) {
    if (delta === 0) {
      if (origin < minimum || origin > maximum) return null;
      continue;
    }

    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return null;
  }

  return entry >= 0 && entry <= 1 ? entry : null;
}

export function crossedTileCoordinates(
  from: PointerSample,
  to: PointerSample,
  tiles: readonly TileHitGeometry[],
): TileCoordinate[] {
  return tiles
    .map((tile, index) => ({
      coordinate: tile.coordinate,
      index,
      progress: segmentEntryProgress(from, to, tile),
    }))
    .filter(
      (
        hit,
      ): hit is {
        coordinate: TileCoordinate;
        index: number;
        progress: number;
      } => hit.progress !== null,
    )
    .sort(
      (first, second) =>
        first.progress - second.progress || first.index - second.index,
    )
    .map(({ coordinate }) => coordinate);
}

function coordinatesMatch(
  first: TileCoordinate,
  second: TileCoordinate,
): boolean {
  return first.row === second.row && first.column === second.column;
}

/**
 * Acquires only unvisited neighbors in the direction of travel. Tile centers
 * make all eight directions symmetric, while the expanded radius covers the
 * visual gap between diagonal tiles. Repeating from each acquired neighbor
 * preserves legitimate fast swipes without ever skipping a tile.
 */
export function acquireDirectionalTileCoordinates(
  to: PointerSample,
  path: TilePath,
  tiles: readonly TileHitGeometry[],
): TileCoordinate[] {
  const acquired: TileCoordinate[] = [];
  const workingPath = [...path];

  for (let step = 0; step < tiles.length; step += 1) {
    const lastCoordinate = workingPath.at(-1);
    if (!lastCoordinate) break;
    const lastTile = tiles.find((tile) =>
      coordinatesMatch(tile.coordinate, lastCoordinate),
    );
    if (!lastTile) break;

    const movementX = to.clientX - lastTile.centerX;
    const movementY = to.clientY - lastTile.centerY;
    const movementLength = Math.hypot(movementX, movementY);
    if (movementLength === 0) break;

    const candidates = tiles
      .filter(
        (tile) =>
          areCoordinatesAdjacent(lastCoordinate, tile.coordinate) &&
          !workingPath.some((coordinate) =>
            coordinatesMatch(coordinate, tile.coordinate),
          ),
      )
      .map((tile) => {
        const directionX = tile.centerX - lastTile.centerX;
        const directionY = tile.centerY - lastTile.centerY;
        const neighborDistance = Math.hypot(directionX, directionY);
        const alignment =
          (movementX * directionX + movementY * directionY) /
          (movementLength * neighborDistance);
        const projection =
          (directionX * movementX + directionY * movementY) /
          (movementLength * movementLength);
        const closestProgress = Math.min(1, Math.max(0, projection));
        const closestX = lastTile.centerX + movementX * closestProgress;
        const closestY = lastTile.centerY + movementY * closestProgress;
        const proximity = Math.hypot(
          tile.centerX - closestX,
          tile.centerY - closestY,
        );
        const tileSize = Math.max(
          tile.right - tile.left,
          tile.bottom - tile.top,
        );
        const acquisitionRadius = tileSize * 0.74;
        const forwardDistance =
          (movementX * directionX + movementY * directionY) / neighborDistance;

        return {
          alignment,
          forwardDistance,
          neighborDistance,
          proximity,
          acquisitionRadius,
          tile,
        };
      })
      .filter(
        (candidate) =>
          candidate.alignment >= Math.cos((38 * Math.PI) / 180) &&
          candidate.proximity <= candidate.acquisitionRadius &&
          candidate.forwardDistance >=
            Math.max(
              candidate.neighborDistance * 0.36,
              candidate.neighborDistance - candidate.acquisitionRadius,
            ),
      )
      .sort(
        (first, second) =>
          second.alignment - first.alignment ||
          first.proximity - second.proximity ||
          first.neighborDistance - second.neighborDistance ||
          first.tile.coordinate.row - second.tile.coordinate.row ||
          first.tile.coordinate.column - second.tile.coordinate.column,
      );

    const next = candidates[0]?.tile.coordinate;
    if (!next) break;
    acquired.push(next);
    workingPath.push(next);
  }

  return acquired;
}

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
