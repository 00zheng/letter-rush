"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import {
  classifySupabaseError,
  reportSupabaseError,
  supabaseErrorMessage,
  type SupabaseErrorKind,
} from "@/lib/supabase/errors";

import styles from "./rematch-controls.module.css";

type RematchStatus =
  "pending" | "accepted" | "declined" | "expired" | "cancelled";

type RematchState = {
  proposal_id: string;
  proposal_status: RematchStatus;
  requested_by_me: boolean;
  can_respond: boolean;
  expires_at: string;
  created_match_id: string | null;
  server_now: string;
};

const MAXIMUM_REMATCH_POLL_ATTEMPTS = 30;
const ACTIVE_MATCH_KEY = "letter-rush:active-match";

function friendlyRematchError(error: unknown, rpcName: string): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  if (message.includes("already pending"))
    return "A request is already pending.";
  if (message.includes("expired")) return "The rematch request expired.";
  if (
    message.includes("another match") ||
    message.includes("another active match")
  )
    return "A player is already in another match.";
  if (message.includes("ranked matchmaking"))
    return "A player is still waiting in ranked matchmaking.";
  if (message.includes("not finalized"))
    return "The previous match is not finalized yet.";
  if (
    message.includes("Not a participant") ||
    message.includes("Only match participants")
  )
    return "Only match participants can request a rematch.";
  if (message.includes("unique private rematch"))
    return "A new private rematch could not be allocated. Try again.";
  if (message.includes("group lobby"))
    return "This match uses the group rematch lobby.";
  return supabaseErrorMessage(error, {
    feature: "Rematches",
    productionMessage: "The rematch request could not be completed. Try again.",
    rpcName,
  });
}

export function TwoPlayerRematchControls({
  matchId,
  mode,
  supabase,
}: {
  matchId: string;
  mode: "private" | "ranked";
  supabase: BrowserSupabaseClient;
}) {
  const router = useRouter();
  const [state, setState] = useState<RematchState | null>(null);
  const [seconds, setSeconds] = useState(15);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const pollingStoppedRef = useRef(false);
  const pollAttemptsRef = useRef(0);
  const redirectingRef = useRef(false);
  const lastReportedLoadErrorRef = useRef<SupabaseErrorKind | null>(null);

  const goToMatch = useCallback(
    (newMatchId: string) => {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      if (mode === "ranked") {
        router.replace(`/ranked/${newMatchId}`);
        return;
      }
      const destination = new URL("/", window.location.origin);
      destination.searchParams.set("match", newMatchId);
      window.location.replace(destination);
    },
    [mode, router],
  );

  const returnToLobby = useCallback(() => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    if (mode === "private") {
      window.localStorage.removeItem(ACTIVE_MATCH_KEY);
    }
    router.replace("/");
  }, [mode, router]);

  const load = useCallback(
    async (explicitRetry = false) => {
      if (
        actionInFlightRef.current ||
        (pollingStoppedRef.current && !explicitRetry)
      ) {
        return;
      }
      if (explicitRetry) {
        pollingStoppedRef.current = false;
        pollAttemptsRef.current = 0;
        setLoadError(null);
      }
      const requestSequence = ++requestSequenceRef.current;
      const { data, error } = await supabase.rpc(
        "get_two_player_rematch_state",
        {
          p_match_id: matchId,
        },
      );
      if (requestSequence !== requestSequenceRef.current) return;
      if (error) {
        const classified = classifySupabaseError(error);
        setLoadError(
          friendlyRematchError(error, "get_two_player_rematch_state"),
        );
        if (lastReportedLoadErrorRef.current !== classified.kind) {
          reportSupabaseError(error, {
            feature: "two-player rematches",
            rpcName: "get_two_player_rematch_state",
          });
          lastReportedLoadErrorRef.current = classified.kind;
        }
        if (classified.kind === "missing_rpc") {
          pollingStoppedRef.current = true;
        }
        return;
      }

      setLoadError(null);
      lastReportedLoadErrorRef.current = null;
      const next = data?.[0] ?? null;
      setState(next);
      if (next?.created_match_id) {
        goToMatch(next.created_match_id);
        return;
      }
      if (
        next &&
        ["declined", "expired", "cancelled"].includes(next.proposal_status)
      ) {
        returnToLobby();
      }
    },
    [goToMatch, matchId, returnToLobby, supabase],
  );

  useEffect(() => {
    mountedRef.current = true;
    pollingStoppedRef.current = false;
    pollAttemptsRef.current = 0;
    const initialLoadId = window.setTimeout(() => void load(), 0);
    const pollId = window.setInterval(() => {
      if (pollAttemptsRef.current >= MAXIMUM_REMATCH_POLL_ATTEMPTS) {
        window.clearInterval(pollId);
        return;
      }
      if (pollingStoppedRef.current) return;
      pollAttemptsRef.current += 1;
      void load();
    }, 1_000);
    const channel = supabase
      .channel(`two-player-rematch:${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "two_player_rematch_proposals",
          filter: `source_match_id=eq.${matchId}`,
        },
        () => void load(),
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
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
            (Date.parse(state.expires_at) - (Date.now() + offset)) / 1_000,
          ),
        ),
      );
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  async function request() {
    requestSequenceRef.current += 1;
    actionInFlightRef.current = true;
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("request_two_player_rematch", {
      p_match_id: matchId,
    });
    actionInFlightRef.current = false;
    if (!mountedRef.current) return;
    setIsWorking(false);
    if (error) {
      reportSupabaseError(error, {
        feature: "two-player rematches",
        rpcName: "request_two_player_rematch",
      });
      setMessage(friendlyRematchError(error, "request_two_player_rematch"));
      return;
    }
    pollingStoppedRef.current = false;
    lastReportedLoadErrorRef.current = null;
    setLoadError(null);
    setState(data?.[0] ?? null);
    setMessage("Rematch requested.");
  }

  async function respond(accept: boolean) {
    if (!state) return;
    requestSequenceRef.current += 1;
    actionInFlightRef.current = true;
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("respond_two_player_rematch", {
      p_proposal_id: state.proposal_id,
      p_accept: accept,
    });
    actionInFlightRef.current = false;
    if (!mountedRef.current) return;
    setIsWorking(false);
    if (error) {
      reportSupabaseError(error, {
        feature: "two-player rematches",
        rpcName: "respond_two_player_rematch",
      });
      setMessage(friendlyRematchError(error, "respond_two_player_rematch"));
      return;
    }
    pollingStoppedRef.current = false;
    lastReportedLoadErrorRef.current = null;
    setLoadError(null);

    const next = data?.[0];
    if (next?.match_id) {
      goToMatch(next.match_id);
      return;
    }
    await load();
  }

  async function cancel() {
    if (!state) return;
    requestSequenceRef.current += 1;
    actionInFlightRef.current = true;
    setIsWorking(true);
    setMessage(null);
    const { error } = await supabase.rpc("cancel_two_player_rematch", {
      p_proposal_id: state.proposal_id,
    });
    actionInFlightRef.current = false;
    if (!mountedRef.current) return;
    setIsWorking(false);
    if (error) {
      reportSupabaseError(error, {
        feature: "two-player rematches",
        rpcName: "cancel_two_player_rematch",
      });
      setMessage(friendlyRematchError(error, "cancel_two_player_rematch"));
      return;
    }
    returnToLobby();
  }

  if (!state) {
    return (
      <div className={styles.rematchPanel}>
        <button
          className={styles.primary}
          disabled={isWorking}
          onClick={() => void request()}
          type="button"
        >
          {isWorking ? "Starting rematch…" : "Rematch"}
        </button>
        {(message ?? loadError) ? (
          <p role="alert">{message ?? loadError}</p>
        ) : null}
        {loadError ? (
          <button
            className={styles.secondary}
            onClick={() => void load(true)}
            type="button"
          >
            Retry status
          </button>
        ) : null}
      </div>
    );
  }

  if (state.proposal_status === "pending") {
    return (
      <div className={styles.rematchPanel} role="status">
        <p>
          {state.requested_by_me ? "Waiting for opponent" : "Rematch requested"}{" "}
          · {seconds}s
        </p>
        {state.can_respond ? (
          <>
            <button
              className={styles.primary}
              disabled={isWorking}
              onClick={() => void respond(true)}
              type="button"
            >
              Accept
            </button>
            <button
              className={styles.secondary}
              disabled={isWorking}
              onClick={() => void respond(false)}
              type="button"
            >
              Decline
            </button>
          </>
        ) : (
          <button
            className={styles.secondary}
            disabled={isWorking}
            onClick={() => void cancel()}
            type="button"
          >
            Cancel request
          </button>
        )}
        {(message ?? loadError) ? (
          <p role="alert">{message ?? loadError}</p>
        ) : null}
        {loadError ? (
          <button
            className={styles.secondary}
            onClick={() => void load(true)}
            type="button"
          >
            Retry status
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <p className={styles.rematchPanel} role="status">
      Rematch {state.proposal_status}.
    </p>
  );
}
