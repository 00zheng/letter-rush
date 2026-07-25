"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

export type PlayerChallenge =
  Database["public"]["Functions"]["get_current_player_challenges"]["Returns"][number];

export function usePlayerChallenges(
  supabase: BrowserSupabaseClient | null,
  enabled = true,
) {
  const [challenges, setChallenges] = useState<PlayerChallenge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!supabase || !enabled) return;
    const requestSequence = ++requestSequenceRef.current;

    const { data, error: challengeError } = await supabase.rpc(
      "get_current_player_challenges",
    );
    if (requestSequence !== requestSequenceRef.current) return;
    if (challengeError) {
      setError("Challenges could not be refreshed. Try again shortly.");
    } else {
      setChallenges(data ?? []);
      setError(null);
    }
    setIsLoading(false);
  }, [enabled, supabase]);

  useEffect(() => {
    if (!supabase || !enabled) return;

    const load = async () => {
      const requestSequence = ++requestSequenceRef.current;
      const { data, error: challengeError } = await supabase.rpc(
        "get_current_player_challenges",
      );
      if (requestSequence !== requestSequenceRef.current) return;
      if (challengeError) {
        setError("Challenges could not be refreshed. Try again shortly.");
      } else {
        setChallenges(data ?? []);
        setError(null);
      }
      setIsLoading(false);
    };

    void load();
    const intervalId = window.setInterval(() => void load(), 2_500);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      requestSequenceRef.current += 1;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, supabase]);

  return {
    challenges: enabled ? challenges : [],
    error: enabled ? error : null,
    isLoading: enabled ? isLoading : false,
    refresh,
  };
}
