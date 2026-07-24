export type TileCoordinate = Readonly<{
  row: number;
  column: number;
}>;

export type TilePath = readonly TileCoordinate[];

export type LetterBoard = readonly (readonly (string | null)[])[];

export type BoardGeometry = Readonly<{
  rows: number;
  columns: number;
  activeCells: readonly boolean[];
}>;

export type WordPathSubmission = Readonly<{
  word: string;
  path: TilePath;
}>;

export type ScoredWordSubmission = WordPathSubmission &
  Readonly<{
    score: number;
  }>;
