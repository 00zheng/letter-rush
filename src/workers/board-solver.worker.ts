/// <reference lib="webworker" />

import {
  GENERATED_DICTIONARY_BUCKETS,
  GENERATED_DICTIONARY_METADATA,
} from "../generated/dictionary/index";
import {
  createDictionaryTrie,
  solveBoardWithTrie,
  type DictionaryTrieNode,
  type SolvedBoardWord,
} from "../game/board-solver";
import { SCORING_RULES_VERSION } from "../game/ruleset";
import type { LetterBoard } from "../game/types";

type BucketLetter = keyof typeof GENERATED_DICTIONARY_BUCKETS;
type SolverRequest = {
  activeCells: boolean[];
  board: LetterBoard;
  cacheKey: string;
  columns: number;
  dictionaryVersion: string;
  id: number;
  minimumWordLength: number;
  rows: number;
  scoringRulesVersion: string;
};
type SolverResponse =
  { id: number; words: SolvedBoardWord[] } | { id: number; error: string };

const bucketCache = new Map<BucketLetter, Promise<readonly string[]>>();
const trieCache = new Map<string, Promise<DictionaryTrieNode>>();
const resultCache = new Map<string, SolvedBoardWord[]>();

function loadBucket(letter: BucketLetter): Promise<readonly string[]> {
  const cached = bucketCache.get(letter);
  if (cached) return cached;
  const pending = GENERATED_DICTIONARY_BUCKETS[letter]().then((contents) =>
    contents ? contents.split("\n") : [],
  );
  bucketCache.set(letter, pending);
  return pending;
}

async function trieForBoard(
  board: LetterBoard,
  dictionaryVersion: string,
): Promise<DictionaryTrieNode> {
  const letters = [
    ...new Set(
      board
        .flat()
        .map((letter) => letter?.toLowerCase())
        .filter((letter): letter is BucketLetter =>
          Boolean(letter && letter in GENERATED_DICTIONARY_BUCKETS),
        ),
    ),
  ].sort();
  const key = `${dictionaryVersion}:${letters.join("")}`;
  const cached = trieCache.get(key);
  if (cached) return cached;

  const pending = Promise.all(letters.map((letter) => loadBucket(letter))).then(
    (buckets) => createDictionaryTrie(buckets.flat()),
  );
  if (trieCache.size >= 8) {
    trieCache.delete(trieCache.keys().next().value ?? "");
  }
  trieCache.set(key, pending);
  return pending;
}

self.addEventListener("message", (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  void (async () => {
    if (
      request.dictionaryVersion !== GENERATED_DICTIONARY_METADATA.version ||
      request.scoringRulesVersion !== SCORING_RULES_VERSION
    ) {
      throw new Error("Unsupported dictionary or scoring version.");
    }

    let words = resultCache.get(request.cacheKey);
    if (!words) {
      words = solveBoardWithTrie({
        activeCells: request.activeCells,
        board: request.board,
        columns: request.columns,
        minimumWordLength: request.minimumWordLength,
        rows: request.rows,
        trie: await trieForBoard(request.board, request.dictionaryVersion),
      });
      if (resultCache.size >= 32) {
        resultCache.delete(resultCache.keys().next().value ?? "");
      }
      resultCache.set(request.cacheKey, words);
    }
    self.postMessage({ id: request.id, words } satisfies SolverResponse);
  })().catch(() => {
    self.postMessage({
      id: request.id,
      error: "Possible-word analysis failed.",
    } satisfies SolverResponse);
  });
});

export {};
