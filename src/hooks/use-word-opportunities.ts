"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  boardAnalysisRegistry,
  isBoardAnalysisAbortError,
  type BoardAnalysisWord,
} from "@/game/board-analysis-client";
import {
  createBoardSolverCacheKey,
  parseBoardSolverCacheKey,
  solveBoardInWorker,
} from "@/game/board-solver-client";
import type { GameRuleset } from "@/game/ruleset";
import type { LetterBoard } from "@/game/types";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import { reportSupabaseError } from "@/lib/supabase/errors";

export type WordOpportunity = BoardAnalysisWord & {
  was_found: boolean;
};

export type WordOpportunityRequestStatus =
  "idle" | "loading" | "success" | "error";

type RequestState = {
  error: string | null;
  generationId: number | null;
  key: string | null;
  status: WordOpportunityRequestStatus;
  words: BoardAnalysisWord[];
};

const IDLE_STATE: RequestState = {
  error: null,
  generationId: null,
  key: null,
  status: "idle",
  words: [],
};

async function loadServerCache(input: {
  generationId: number;
  matchId: string;
  signal: AbortSignal;
  supabase: BrowserSupabaseClient;
}): Promise<unknown> {
  const controller = new AbortController();
  let exceededDeadline = false;
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  const timeoutId = window.setTimeout(() => {
    exceededDeadline = true;
    controller.abort();
  }, 2_000);

  try {
    const { data, error } = await input.supabase
      .rpc("get_match_word_opportunities", {
        p_match_id: input.matchId,
      })
      .abortSignal(controller.signal);
    if (error) {
      if (input.signal.aborted) {
        const cancelled = new Error("Board cache request was cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      reportSupabaseError(error, {
        feature: "completed-board analysis",
        requestGenerationId: input.generationId,
        rpcName: "get_match_word_opportunities",
      });
      throw error;
    }
    return data ?? [];
  } catch (error: unknown) {
    if (exceededDeadline) {
      const timeout = new Error("Board analysis cache request timed out.");
      timeout.name = "AbortError";
      throw timeout;
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    input.signal.removeEventListener("abort", abort);
  }
}

export function useWordOpportunities(
  board: LetterBoard | null,
  ruleset: GameRuleset | null,
  foundWords: readonly string[],
  enabled: boolean,
  supabase: BrowserSupabaseClient | null = null,
  matchId: string | null = null,
) {
  const [attempt, setAttempt] = useState(0);
  const requestKey =
    enabled && board && ruleset
      ? createBoardSolverCacheKey(board, ruleset)
      : null;
  const foundKey = foundWords.join("\n").toUpperCase();
  const normalizedFoundWords = useMemo(
    () => new Set(foundKey ? foundKey.split("\n") : []),
    [foundKey],
  );
  const [state, setState] = useState<RequestState>(IDLE_STATE);

  useEffect(() => {
    if (!requestKey) return;

    const solverInput = parseBoardSolverCacheKey(requestKey);
    const subscription = boardAnalysisRegistry.request({
      key: requestKey,
      loadServerCache:
        supabase && matchId
          ? (signal, generationId) =>
              loadServerCache({
                generationId,
                matchId,
                signal,
                supabase,
              })
          : undefined,
      solveLocally: (signal) =>
        solveBoardInWorker(solverInput, { signal, timeoutMs: 7_000 }),
    });
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      setState({
        error: null,
        generationId: subscription.generationId,
        key: requestKey,
        status: "loading",
        words: [],
      });
    });

    void subscription.promise.then(
      (result) => {
        if (!mounted) return;
        setState((current) =>
          current.key === requestKey &&
          current.generationId === result.generationId
            ? {
                error: null,
                generationId: result.generationId,
                key: requestKey,
                status: "success",
                words: result.words,
              }
            : current,
        );
      },
      (error: unknown) => {
        if (!mounted || isBoardAnalysisAbortError(error)) return;
        setState((current) =>
          current.key === requestKey &&
          current.generationId === subscription.generationId
            ? {
                error:
                  error instanceof Error &&
                  error.message.includes("taking longer than expected")
                    ? "Possible-word analysis is taking longer than expected."
                    : "Possible-word analysis could not be completed.",
                generationId: subscription.generationId,
                key: requestKey,
                status: "error",
                words: [],
              }
            : current,
        );
      },
    );

    return () => {
      mounted = false;
      subscription.release();
    };
  }, [attempt, matchId, requestKey, supabase]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const visibleState =
    requestKey === null
      ? IDLE_STATE
      : state.key === requestKey
        ? state
        : {
            error: null,
            generationId: null,
            key: requestKey,
            status: "loading" as const,
            words: [],
          };
  const words = useMemo(
    () =>
      visibleState.words.map((entry) => ({
        ...entry,
        was_found: normalizedFoundWords.has(entry.word),
      })),
    [normalizedFoundWords, visibleState.words],
  );

  return {
    error: visibleState.error,
    generationId: visibleState.generationId,
    retry,
    status: visibleState.status,
    words,
  };
}
