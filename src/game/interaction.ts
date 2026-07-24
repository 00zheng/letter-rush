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
