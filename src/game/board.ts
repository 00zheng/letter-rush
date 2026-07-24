import type { LetterBoard } from "./types";

export const DEFAULT_BOARD = [
  ["C", "A", "T", "S"],
  ["R", "E", "A", "M"],
  ["T", "I", "L", "E"],
  ["S", "O", "N", "G"],
] as const satisfies LetterBoard;

const UINT32_RANGE = 4_294_967_296;

/**
 * A small LCG with 32-bit arithmetic. It is intentionally deterministic across
 * browsers and Node.js; it is not intended for cryptographic use.
 */
export function createSeededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;

  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / UINT32_RANGE;
  };
}

function rotateClockwise(board: LetterBoard): string[][] {
  const size = board.length;

  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => board[size - 1 - column][row]),
  );
}

function mirrorHorizontally(board: LetterBoard): string[][] {
  return board.map((row) => [...row].reverse());
}

/**
 * Seeded boards are rotations/reflections of the prototype board. This keeps
 * the small placeholder dictionary playable while still making room boards
 * deterministic and seed-specific.
 */
export function generateBoardFromSeed(seed: number): string[][] {
  const random = createSeededRandom(seed);
  const transform = Math.floor(random() * 8);
  let board: LetterBoard =
    transform >= 4 ? mirrorHorizontally(DEFAULT_BOARD) : DEFAULT_BOARD;

  for (let turn = 0; turn < transform % 4; turn += 1) {
    board = rotateClockwise(board);
  }

  return board.map((row) => [...row]);
}
