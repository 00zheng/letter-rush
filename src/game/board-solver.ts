import { calculateWordScore } from "./logic";
import type { LetterBoard } from "./types";

export type DictionaryTrieNode = {
  children: Map<string, DictionaryTrieNode>;
  word: string | null;
};

export type SolvedBoardWord = {
  score: number;
  word: string;
  word_length: number;
};

export function compareSolvedBoardWords(
  first: SolvedBoardWord,
  second: SolvedBoardWord,
): number {
  return (
    second.word_length - first.word_length ||
    second.score - first.score ||
    first.word.localeCompare(second.word)
  );
}

export function createDictionaryTrie(
  words: Iterable<string>,
  minimumWordLength = 3,
): DictionaryTrieNode {
  const root: DictionaryTrieNode = { children: new Map(), word: null };

  for (const candidate of words) {
    const normalized = candidate.trim().toUpperCase();
    if (
      normalized.length < minimumWordLength ||
      !/^[A-Z]+$/u.test(normalized)
    ) {
      continue;
    }

    let node = root;
    for (const letter of normalized) {
      let child = node.children.get(letter);
      if (!child) {
        child = { children: new Map(), word: null };
        node.children.set(letter, child);
      }
      node = child;
    }
    node.word = normalized;
  }

  return root;
}

export function solveBoardWithTrie(input: {
  activeCells: readonly boolean[];
  board: LetterBoard;
  columns: number;
  minimumWordLength: number;
  rows: number;
  trie: DictionaryTrieNode;
  maximumResults?: number;
}): SolvedBoardWord[] {
  const {
    activeCells,
    board,
    columns,
    minimumWordLength,
    rows,
    trie,
    maximumResults = 10,
  } = input;
  const bestWords = new Map<string, SolvedBoardWord>();
  const visited = new Uint8Array(rows * columns);
  const resultLimit = Math.max(0, maximumResults);

  function considerWord(word: string) {
    if (resultLimit === 0 || bestWords.has(word)) return;

    const candidate = {
      score: calculateWordScore(word),
      word,
      word_length: word.length,
    };
    if (bestWords.size < resultLimit) {
      bestWords.set(word, candidate);
      return;
    }

    const worst = [...bestWords.values()].sort(compareSolvedBoardWords).at(-1);
    if (!worst || compareSolvedBoardWords(candidate, worst) >= 0) return;
    bestWords.delete(worst.word);
    bestWords.set(word, candidate);
  }

  function search(row: number, column: number, node: DictionaryTrieNode) {
    const index = row * columns + column;
    if (
      row < 0 ||
      column < 0 ||
      row >= rows ||
      column >= columns ||
      !activeCells[index] ||
      visited[index]
    ) {
      return;
    }

    const letter = board[row]?.[column]?.toUpperCase();
    if (!letter) return;
    const next = node.children.get(letter);
    if (!next) return;

    visited[index] = 1;
    if (next.word && next.word.length >= minimumWordLength) {
      considerWord(next.word);
    }

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        if (rowOffset !== 0 || columnOffset !== 0) {
          search(row + rowOffset, column + columnOffset, next);
        }
      }
    }
    visited[index] = 0;
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      search(row, column, trie);
    }
  }

  return [...bestWords.values()].sort(compareSolvedBoardWords);
}

export function solveBoardWords(input: {
  activeCells: readonly boolean[];
  board: LetterBoard;
  columns: number;
  dictionaryWords: Iterable<string>;
  minimumWordLength: number;
  rows: number;
  maximumResults?: number;
}): SolvedBoardWord[] {
  return solveBoardWithTrie({
    ...input,
    trie: createDictionaryTrie(input.dictionaryWords, input.minimumWordLength),
  });
}
