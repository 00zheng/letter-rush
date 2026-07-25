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

export type PointerSample = {
  clientX: number;
  clientY: number;
  timeStamp?: number;
};

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
export const DIRECTIONAL_ACTIVATION_RATIO = 0.48;
export const DIRECTIONAL_CORRIDOR_RATIO = 0.23;
export const DIRECTIONAL_DEAD_ZONE_RATIO = 0.14;
export const DIRECTIONAL_SECTOR_HALF_ANGLE_DEGREES = 22.5;
export const DIRECTIONAL_HYSTERESIS_DEGREES = 3;
export const POINTER_INTERPOLATION_STEP_RATIO = 0.35;

export type DirectionalSector = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type DirectionalAcquisitionDiagnostic = {
  acquired: TileCoordinate | null;
  activationThreshold: number | null;
  candidate: TileCoordinate | null;
  current: PointerSample;
  directionalSector: DirectionalSector | null;
  forwardProjection: number | null;
  lastTileCenter: PointerSample | null;
  movementAngleDegrees: number | null;
  perpendicularDeviation: number | null;
  previous: PointerSample;
  remainingSegment: { from: PointerSample; to: PointerSample };
};

export type DirectionalAcquisitionResult = {
  acquired: TileCoordinate[];
  directionalSector: DirectionalSector | null;
  remainingSegmentStart: PointerSample;
};

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

function normalizedAngleDegrees(x: number, y: number): number {
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  return angle < 0 ? angle + 360 : angle;
}

function angleDistance(first: number, second: number): number {
  const difference = Math.abs(first - second) % 360;
  return Math.min(difference, 360 - difference);
}

function nearestDirectionalSector(angle: number): DirectionalSector {
  return Math.floor(
    ((angle + DIRECTIONAL_SECTOR_HALF_ANGLE_DEGREES) % 360) / 45,
  ) as DirectionalSector;
}

function lockedDirectionalSector(
  angle: number,
  previous: DirectionalSector | null,
): DirectionalSector {
  if (
    previous !== null &&
    angleDistance(angle, previous * 45) <=
      DIRECTIONAL_SECTOR_HALF_ANGLE_DEGREES + DIRECTIONAL_HYSTERESIS_DEGREES
  ) {
    return previous;
  }
  return nearestDirectionalSector(angle);
}

function sectorForNeighbor(
  from: TileCoordinate,
  to: TileCoordinate,
): DirectionalSector {
  const rowOffset = to.row - from.row;
  const columnOffset = to.column - from.column;
  const sectorByOffset: Record<string, DirectionalSector> = {
    "0:1": 0,
    "1:1": 1,
    "1:0": 2,
    "1:-1": 3,
    "0:-1": 4,
    "-1:-1": 5,
    "-1:0": 6,
    "-1:1": 7,
  };
  return sectorByOffset[`${rowOffset}:${columnOffset}`];
}

/**
 * Consumes one real pointer segment. Each acquisition advances the segment
 * start to the exact activation-plane crossing, so a single endpoint is never
 * re-used as a fresh movement vector from a newly selected tile.
 */
export function acquireDirectionalTileCoordinates(
  from: PointerSample,
  to: PointerSample,
  path: TilePath,
  tiles: readonly TileHitGeometry[],
  previousSector: DirectionalSector | null = null,
  diagnostic?: (event: DirectionalAcquisitionDiagnostic) => void,
): DirectionalAcquisitionResult {
  const acquired: TileCoordinate[] = [];
  const workingPath = [...path];
  let remainingStart = from;
  let sector = previousSector;

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
    const movementAngle =
      movementLength > 0 ? normalizedAngleDegrees(movementX, movementY) : null;
    const selectable = tiles.filter(
      (tile) =>
        areCoordinatesAdjacent(lastCoordinate, tile.coordinate) &&
        !workingPath.some((coordinate) =>
          coordinatesMatch(coordinate, tile.coordinate),
        ),
    );
    const minimumNeighborDistance = Math.min(
      ...selectable.map((tile) =>
        Math.hypot(
          tile.centerX - lastTile.centerX,
          tile.centerY - lastTile.centerY,
        ),
      ),
    );

    if (
      movementAngle === null ||
      !Number.isFinite(minimumNeighborDistance) ||
      movementLength < minimumNeighborDistance * DIRECTIONAL_DEAD_ZONE_RATIO
    ) {
      break;
    }

    sector = lockedDirectionalSector(movementAngle, sector);
    const candidate = selectable.find(
      (tile) => sectorForNeighbor(lastCoordinate, tile.coordinate) === sector,
    );
    if (!candidate) {
      diagnostic?.({
        acquired: null,
        activationThreshold: null,
        candidate: null,
        current: to,
        directionalSector: sector,
        forwardProjection: null,
        lastTileCenter: {
          clientX: lastTile.centerX,
          clientY: lastTile.centerY,
        },
        movementAngleDegrees: movementAngle,
        perpendicularDeviation: null,
        previous: from,
        remainingSegment: { from: remainingStart, to },
      });
      break;
    }

    const directionX = candidate.centerX - lastTile.centerX;
    const directionY = candidate.centerY - lastTile.centerY;
    const neighborDistance = Math.hypot(directionX, directionY);
    const unitX = directionX / neighborDistance;
    const unitY = directionY / neighborDistance;
    const activationThreshold = neighborDistance * DIRECTIONAL_ACTIVATION_RATIO;
    const startOffsetX = remainingStart.clientX - lastTile.centerX;
    const startOffsetY = remainingStart.clientY - lastTile.centerY;
    const startForward = startOffsetX * unitX + startOffsetY * unitY;
    const endForward = movementX * unitX + movementY * unitY;
    const forwardTravel = endForward - startForward;

    if (
      endForward < activationThreshold ||
      (startForward < activationThreshold && forwardTravel <= 0)
    ) {
      break;
    }

    const progress =
      startForward >= activationThreshold
        ? 0
        : (activationThreshold - startForward) / forwardTravel;
    if (progress < 0 || progress > 1) break;

    const acquisitionPoint = {
      clientX:
        remainingStart.clientX +
        (to.clientX - remainingStart.clientX) * progress,
      clientY:
        remainingStart.clientY +
        (to.clientY - remainingStart.clientY) * progress,
    };
    const acquisitionOffsetX = acquisitionPoint.clientX - lastTile.centerX;
    const acquisitionOffsetY = acquisitionPoint.clientY - lastTile.centerY;
    const perpendicularDeviation = Math.abs(
      acquisitionOffsetX * -unitY + acquisitionOffsetY * unitX,
    );
    const corridorWidth = neighborDistance * DIRECTIONAL_CORRIDOR_RATIO;

    if (perpendicularDeviation > corridorWidth) {
      diagnostic?.({
        acquired: null,
        activationThreshold,
        candidate: candidate.coordinate,
        current: to,
        directionalSector: sector,
        forwardProjection: endForward,
        lastTileCenter: {
          clientX: lastTile.centerX,
          clientY: lastTile.centerY,
        },
        movementAngleDegrees: movementAngle,
        perpendicularDeviation,
        previous: from,
        remainingSegment: { from: remainingStart, to },
      });
      break;
    }

    acquired.push(candidate.coordinate);
    workingPath.push(candidate.coordinate);
    remainingStart = acquisitionPoint;
    diagnostic?.({
      acquired: candidate.coordinate,
      activationThreshold,
      candidate: candidate.coordinate,
      current: to,
      directionalSector: sector,
      forwardProjection: endForward,
      lastTileCenter: {
        clientX: lastTile.centerX,
        clientY: lastTile.centerY,
      },
      movementAngleDegrees: movementAngle,
      perpendicularDeviation,
      previous: from,
      remainingSegment: { from: remainingStart, to },
    });
  }

  return {
    acquired,
    directionalSector: sector,
    remainingSegmentStart: remainingStart,
  };
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
      timeStamp:
        from.timeStamp === undefined || to.timeStamp === undefined
          ? undefined
          : from.timeStamp + (to.timeStamp - from.timeStamp) * progress,
    };
  });
}

export function orderPointerSamples(
  samples: readonly PointerSample[],
): PointerSample[] {
  return samples
    .map((sample, index) => ({ index, sample }))
    .sort(
      (first, second) =>
        (first.sample.timeStamp ?? 0) - (second.sample.timeStamp ?? 0) ||
        first.index - second.index,
    )
    .map(({ sample }) => sample);
}

export function minimumAdjacentTileCenterDistance(
  tiles: readonly TileHitGeometry[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const tile of tiles) {
    for (const candidate of tiles) {
      if (
        tile === candidate ||
        !areCoordinatesAdjacent(tile.coordinate, candidate.coordinate)
      ) {
        continue;
      }
      minimum = Math.min(
        minimum,
        Math.hypot(
          candidate.centerX - tile.centerX,
          candidate.centerY - tile.centerY,
        ),
      );
    }
  }
  return Number.isFinite(minimum) ? minimum : 1;
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
