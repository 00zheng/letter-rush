"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createBoardSolverCacheKey,
  solveBoardInWorker,
} from "@/game/board-solver-client";
import type { GameRuleset } from "@/game/ruleset";
import type { LetterBoard } from "@/game/types";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import {
  classifySupabaseError,
  reportSupabaseError,
  supabaseErrorMessage,
} from "@/lib/supabase/errors";

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
  supabase: BrowserSupabaseClient | null = null,
  matchId: string | null = null,
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
    void (async () => {
      let serverError: unknown = null;

      if (supabase && matchId) {
        const { data, error } = await supabase.rpc(
          "get_match_word_opportunities",
          { p_match_id: matchId },
        );
        if (!active) return;
        if (!error) {
          setResult({
            error: null,
            key: requestKey,
            words: data ?? [],
          });
          return;
        }

        serverError = error;
        const classified = classifySupabaseError(error);
        reportSupabaseError(error, {
          feature: "completed-board analysis",
          rpcName: "get_match_word_opportunities",
        });
        if (
          !["missing_rpc", "network_unavailable", "request_timeout"].includes(
            classified.kind,
          )
        ) {
          setResult({
            error: supabaseErrorMessage(error, {
              feature: "Board analysis",
              productionMessage:
                "Possible-word analysis is not available for this result.",
              rpcName: "get_match_word_opportunities",
            }),
            key: requestKey,
            words: [],
          });
          return;
        }
      }

      try {
        const words = await solveBoardInWorker(board, ruleset);
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
      } catch (error: unknown) {
        if (!active) return;
        setResult({
          error:
            error instanceof Error &&
            error.message.includes("taking longer than expected")
              ? "Possible-word analysis is taking longer than expected."
              : serverError
                ? supabaseErrorMessage(serverError, {
                    feature: "Board analysis",
                    productionMessage:
                      "Possible-word analysis could not be completed.",
                    rpcName: "get_match_word_opportunities",
                  })
                : "Possible-word analysis could not be completed.",
          key: requestKey,
          words: [],
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    attempt,
    board,
    matchId,
    normalizedFoundWords,
    requestKey,
    ruleset,
    supabase,
  ]);

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
