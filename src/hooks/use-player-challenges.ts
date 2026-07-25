"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import {
  classifySupabaseError,
  reportSupabaseError,
  supabaseErrorMessage,
} from "@/lib/supabase/errors";

export type PlayerChallenge =
  Database["public"]["Functions"]["get_current_player_challenges"]["Returns"][number];

const CHALLENGE_POLL_INTERVAL_MS = 10_000;
const MAXIMUM_CHALLENGE_POLL_ATTEMPTS = 12;

export function usePlayerChallenges(
  supabase: BrowserSupabaseClient | null,
  enabled = true,
) {
  const [challenges, setChallenges] = useState<PlayerChallenge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const pollingStoppedRef = useRef(false);
  const pollAttemptsRef = useRef(0);

  const load = useCallback(
    async (explicitRetry = false) => {
      if (!supabase || !enabled) return;
      if (pollingStoppedRef.current && !explicitRetry) return;
      if (explicitRetry) {
        pollingStoppedRef.current = false;
        pollAttemptsRef.current = 0;
        setIsLoading(true);
      }
      const requestSequence = ++requestSequenceRef.current;

      const { data, error: challengeError } = await supabase.rpc(
        "get_current_player_challenges",
      );
      if (requestSequence !== requestSequenceRef.current) return;
      if (challengeError) {
        const classified = classifySupabaseError(challengeError);
        setError(
          supabaseErrorMessage(challengeError, {
            feature: "Challenges",
            productionMessage:
              "Challenges could not be refreshed. Other game modes are still available.",
            rpcName: "get_current_player_challenges",
          }),
        );
        reportSupabaseError(challengeError, {
          feature: "player challenges",
          rpcName: "get_current_player_challenges",
        });
        if (classified.kind === "missing_rpc") {
          pollingStoppedRef.current = true;
        }
      } else {
        setChallenges(data ?? []);
        setError(null);
      }
      setIsLoading(false);
    },
    [enabled, supabase],
  );

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!supabase || !enabled) return;

    pollingStoppedRef.current = false;
    pollAttemptsRef.current = 0;
    const initialLoadId = window.setTimeout(() => void load(), 0);
    const intervalId = window.setInterval(() => {
      if (pollAttemptsRef.current >= MAXIMUM_CHALLENGE_POLL_ATTEMPTS) {
        window.clearInterval(intervalId);
        return;
      }
      if (pollingStoppedRef.current) return;
      pollAttemptsRef.current += 1;
      void load();
    }, CHALLENGE_POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !pollingStoppedRef.current
      ) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange(() => {
      pollingStoppedRef.current = false;
      pollAttemptsRef.current = 0;
      void load(true);
    });

    return () => {
      requestSequenceRef.current += 1;
      window.clearTimeout(initialLoadId);
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
      authSubscription.unsubscribe();
    };
  }, [enabled, load, supabase]);

  return {
    challenges: enabled ? challenges : [],
    error: enabled ? error : null,
    isLoading: enabled ? isLoading : false,
    refresh,
  };
}
