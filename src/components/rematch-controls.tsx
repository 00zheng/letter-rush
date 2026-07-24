"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";

export function RankedRematchControls({
  matchId,
  supabase,
}: {
  matchId: string;
  supabase: BrowserSupabaseClient;
}) {
  const router = useRouter();
  const [state, setState] = useState<{
    proposal_id: string;
    proposal_status: "pending" | "accepted" | "declined" | "expired";
    requested_by_me: boolean;
    can_respond: boolean;
    expires_at: string;
    created_match_id: string | null;
    server_now: string;
  } | null>(null);
  const [seconds, setSeconds] = useState(30);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("get_ranked_rematch_state", {
      p_match_id: matchId,
    });
    const next = data?.[0] ?? null;
    setState(next);
    if (next?.created_match_id) {
      router.replace(`/ranked/${next.created_match_id}`);
    }
  }, [matchId, router, supabase]);

  useEffect(() => {
    const initialLoadId = window.setTimeout(() => void load(), 0);
    const pollId = window.setInterval(() => void load(), 2_000);
    const channel = supabase
      .channel(`ranked-rematch:${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ranked_rematch_proposals",
          filter: `source_match_id=eq.${matchId}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      window.clearTimeout(initialLoadId);
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [load, matchId, supabase]);

  useEffect(() => {
    if (!state || state.proposal_status !== "pending") return;
    const offset = Date.parse(state.server_now) - Date.now();
    const update = () =>
      setSeconds(
        Math.max(
          0,
          Math.ceil(
            (Date.parse(state.expires_at) - (Date.now() + offset)) / 1000,
          ),
        ),
      );
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  async function request() {
    setIsWorking(true);
    const { error } = await supabase.rpc("request_ranked_rematch", {
      p_match_id: matchId,
    });
    setIsWorking(false);
    setMessage(
      error ? "The rematch request could not be sent." : "Rematch requested.",
    );
    await load();
  }

  async function respond(accept: boolean) {
    if (!state) return;
    setIsWorking(true);
    const { data, error } = await supabase.rpc("respond_ranked_rematch", {
      p_proposal_id: state.proposal_id,
      p_accept: accept,
    });
    setIsWorking(false);
    if (error) {
      setMessage("The rematch response could not be saved.");
      return;
    }
    const next = data?.[0];
    if (next?.match_id) router.replace(`/ranked/${next.match_id}`);
    else setMessage(accept ? "The proposal expired." : "Rematch declined.");
    await load();
  }

  if (!state) {
    return (
      <button disabled={isWorking} onClick={() => void request()} type="button">
        {isWorking ? "Requesting…" : "Request ranked rematch"}
      </button>
    );
  }

  if (state.proposal_status === "pending") {
    return (
      <div role="status">
        <p>
          {state.requested_by_me
            ? `Waiting for opponent · ${seconds}s`
            : `Rematch requested · ${seconds}s`}
        </p>
        {state.can_respond ? (
          <>
            <button
              disabled={isWorking}
              onClick={() => void respond(true)}
              type="button"
            >
              Accept rematch
            </button>
            <button
              disabled={isWorking}
              onClick={() => void respond(false)}
              type="button"
            >
              Decline
            </button>
          </>
        ) : null}
        {message ? <p>{message}</p> : null}
      </div>
    );
  }

  return <p role="status">Rematch {state.proposal_status}.</p>;
}
