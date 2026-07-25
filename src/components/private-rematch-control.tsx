"use client";

import { useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";

function friendlyGroupRematchError(message: string | undefined) {
  if (message?.includes("active match"))
    return "Finish your active match before creating a rematch lobby.";
  if (message?.includes("completed private"))
    return "The previous private match is not finalized yet.";
  if (message?.includes("participant"))
    return "Only prior participants can create this rematch lobby.";
  return "The rematch server is unavailable. Try again.";
}

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
      setMessage(friendlyGroupRematchError(error?.message));
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
        {isWorking ? "Creating…" : "Create group rematch lobby"}
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </>
  );
}
