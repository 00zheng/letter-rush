"use client";

import { useEffect, useRef } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";

const MATCH_HEARTBEAT_INTERVAL_MS = 5_000;

export function useMatchPresence({
  enabled,
  matchId,
  supabase,
}: {
  enabled: boolean;
  matchId: string;
  supabase: BrowserSupabaseClient;
}) {
  const heartbeatInFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const heartbeat = async () => {
      if (heartbeatInFlightRef.current || !navigator.onLine) return;
      heartbeatInFlightRef.current = true;
      await supabase.rpc("heartbeat_match_presence", {
        p_match_id: matchId,
      });
      heartbeatInFlightRef.current = false;
    };
    const reportDisconnect = () => {
      if (!active) return;
      void supabase.rpc("report_match_disconnect", {
        p_match_id: matchId,
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };

    const initialHeartbeat = window.setTimeout(() => void heartbeat(), 0);
    const interval = window.setInterval(
      () => void heartbeat(),
      MATCH_HEARTBEAT_INTERVAL_MS,
    );
    window.addEventListener("online", heartbeat);
    window.addEventListener("offline", reportDisconnect);
    window.addEventListener("pagehide", reportDisconnect);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      active = false;
      window.clearTimeout(initialHeartbeat);
      window.clearInterval(interval);
      window.removeEventListener("online", heartbeat);
      window.removeEventListener("offline", reportDisconnect);
      window.removeEventListener("pagehide", reportDisconnect);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, matchId, supabase]);
}
