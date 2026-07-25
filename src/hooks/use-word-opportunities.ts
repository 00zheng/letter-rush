"use client";

import { useEffect, useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

export type WordOpportunity =
  Database["public"]["Functions"]["get_match_word_opportunities"]["Returns"][number];

export function useWordOpportunities(
  supabase: BrowserSupabaseClient | null,
  matchId: string | null,
  enabled: boolean,
) {
  const requestKey = enabled && matchId ? matchId : null;
  const [result, setResult] = useState<{
    error: string | null;
    key: string | null;
    words: WordOpportunity[];
  }>({ error: null, key: null, words: [] });

  useEffect(() => {
    if (!supabase || !requestKey) return;

    let active = true;
    void supabase
      .rpc("get_match_word_opportunities", { p_match_id: requestKey })
      .then(({ data, error: opportunityError }) => {
        if (!active) return;
        setResult({
          error: opportunityError
            ? "The longest board words could not be loaded."
            : null,
          key: requestKey,
          words: opportunityError ? [] : (data ?? []),
        });
      });

    return () => {
      active = false;
    };
  }, [requestKey, supabase]);

  return {
    error: result.key === requestKey ? result.error : null,
    isLoading: requestKey !== null && result.key !== requestKey,
    words: result.key === requestKey ? result.words : [],
  };
}
