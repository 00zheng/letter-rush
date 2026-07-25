"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createBoardSolverCacheKey,
  solveBoardInWorker,
} from "@/game/board-solver-client";
import type { GameRuleset } from "@/game/ruleset";
import type { LetterBoard } from "@/game/types";

export type WordOpportunity = {
  recognizable: boolean;
  score: number;
  was_found: boolean;
  word: string;
  word_length: number;
};

export function useWordOpportunities(
  board: LetterBoard | null,
  ruleset: GameRuleset | null,
  foundWords: readonly string[],
  enabled: boolean,
) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = useMemo(
    () =>
      enabled && board && ruleset
        ? createBoardSolverCacheKey(board, ruleset)
        : null,
    [board, enabled, ruleset],
  );
  const foundKey = foundWords.join("\n").toUpperCase();
  const normalizedFoundWords = useMemo(
    () => new Set(foundKey ? foundKey.split("\n") : []),
    [foundKey],
  );
  const [result, setResult] = useState<{
    error: string | null;
    key: string | null;
    words: WordOpportunity[];
  }>({ error: null, key: null, words: [] });

  useEffect(() => {
    if (!requestKey || !board || !ruleset) return;
    let active = true;
    void solveBoardInWorker(board, ruleset).then(
      (words) => {
        if (!active) return;
        setResult({
          error: null,
          key: requestKey,
          words: words.map((entry) => ({
            ...entry,
            recognizable: true,
            was_found: normalizedFoundWords.has(entry.word),
          })),
        });
      },
      (error: unknown) => {
        if (!active) return;
        setResult({
          error:
            error instanceof Error &&
            error.message.includes("taking longer than expected")
              ? "Possible-word analysis is taking longer than expected."
              : "Possible-word analysis could not be completed.",
          key: requestKey,
          words: [],
        });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, board, normalizedFoundWords, requestKey, ruleset]);

  const retry = useCallback(() => {
    setResult((current) => ({ ...current, error: null, key: null }));
    setAttempt((current) => current + 1);
  }, []);

  return {
    error: result.key === requestKey ? result.error : null,
    isLoading: requestKey !== null && result.key !== requestKey,
    retry,
    words: result.key === requestKey ? result.words : [],
  };
}
