import type { LetterBoard } from "./types";
import {
  BOARD_GENERATION_VERSION,
  LEGACY_BOARD_GENERATION_VERSION,
  type GameRuleset,
} from "./ruleset";

export const DEFAULT_BOARD = [
  ["C", "A", "T", "S"],
  ["R", "E", "A", "M"],
  ["T", "I", "L", "E"],
  ["S", "O", "N", "G"],
] as const satisfies LetterBoard;

const UINT32_RANGE = 4_294_967_296;

/**
 * Weighted English letter distribution for weighted-v2. Keeping this explicit
 * and versioned means stored matches never change when a later distribution is
 * introduced.
 */
export const WEIGHTED_LETTERS_V2 =
  "EEEEEEEEEEEEAAAAAAAAAIIIIIIIIIOOOOOOOONNNNNNRRRRRRTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPFFHHVVWWYYKJXQZ";
const VOWELS = "AEIOU";

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

type CompleteLetterBoard = readonly (readonly string[])[];

function rotateClockwise(board: CompleteLetterBoard): string[][] {
  const size = board.length;

  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => board[size - 1 - column][row]),
  );
}

function mirrorHorizontally(board: CompleteLetterBoard): string[][] {
  return board.map((row) => [...row].reverse());
}

/**
 * Seeded boards are rotations/reflections of the prototype board. This keeps
 * legacy matches deterministic and seed-specific while preserving their
 * original board-generation contract.
 */
export function generateBoardFromSeed(seed: number): string[][] {
  const random = createSeededRandom(seed);
  const transform = Math.floor(random() * 8);
  let board: CompleteLetterBoard =
    transform >= 4 ? mirrorHorizontally(DEFAULT_BOARD) : DEFAULT_BOARD;

  for (let turn = 0; turn < transform % 4; turn += 1) {
    board = rotateClockwise(board);
  }

  return board.map((row) => [...row]);
}

function generateWeightedBoard(
  seed: number,
  ruleset: GameRuleset,
): LetterBoard {
  const random = createSeededRandom(seed);
  const board = Array.from({ length: ruleset.rows }, () =>
    Array<string | null>(ruleset.columns).fill(null),
  );
  const activeCoordinates: { row: number; column: number }[] = [];
  const consonantCoordinates: { row: number; column: number }[] = [];
  let vowelCount = 0;

  for (let row = 0; row < ruleset.rows; row += 1) {
    for (let column = 0; column < ruleset.columns; column += 1) {
      const index = row * ruleset.columns + column;
      if (!ruleset.activeCells[index]) continue;

      const letter =
        WEIGHTED_LETTERS_V2[Math.floor(random() * WEIGHTED_LETTERS_V2.length)];
      board[row][column] = letter;
      activeCoordinates.push({ row, column });

      if (VOWELS.includes(letter)) {
        vowelCount += 1;
      } else {
        consonantCoordinates.push({ row, column });
      }
    }
  }

  const minimumVowels = Math.max(2, Math.ceil(activeCoordinates.length * 0.28));
  while (vowelCount < minimumVowels && consonantCoordinates.length > 0) {
    const coordinateIndex = Math.floor(random() * consonantCoordinates.length);
    const [coordinate] = consonantCoordinates.splice(coordinateIndex, 1);
    board[coordinate.row][coordinate.column] =
      VOWELS[Math.floor(random() * VOWELS.length)];
    vowelCount += 1;
  }

  return board;
}

/**
 * Generates a board from the complete immutable match inputs. legacy-v1 is
 * retained so previously stored seeds continue to resolve to their old board.
 */
export function generateBoard(seed: number, ruleset: GameRuleset): LetterBoard {
  if (ruleset.boardGenerationVersion === LEGACY_BOARD_GENERATION_VERSION) {
    return generateBoardFromSeed(seed);
  }

  if (ruleset.boardGenerationVersion === BOARD_GENERATION_VERSION) {
    return generateWeightedBoard(seed, ruleset);
  }

  throw new RangeError("Unsupported board-generation version.");
}
