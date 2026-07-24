"use client";

import { useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";

export function PrivateRematchControl({
  matchId,
  supabase,
}: {
  matchId: string;
  supabase: BrowserSupabaseClient;
}) {
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function create() {
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("create_private_rematch", {
      p_match_id: matchId,
    });
    setIsWorking(false);
    const rematch = data?.[0];
    if (error || !rematch) {
      setMessage("The private rematch lobby could not be created.");
      return;
    }
    const url = new URL("/", window.location.origin);
    url.searchParams.set("match", rematch.match_id);
    url.searchParams.set("room", rematch.room_code);
    window.location.assign(url);
  }

  return (
    <>
      <button disabled={isWorking} onClick={() => void create()} type="button">
        {isWorking ? "Creating…" : "Create private rematch"}
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </>
  );
}
