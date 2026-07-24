"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAnonymousAuth } from "@/hooks/use-anonymous-auth";
import {
  OPEN_MATCH_WAIT_MS,
  QUEUE_HEARTBEAT_INTERVAL_MS,
  allowedRatingGap,
} from "@/ranked/matchmaking";
import type { RankedQueueState } from "@/ranked/types";

import { AppHeader } from "./app-header";
import styles from "./ranked.module.css";

function queueErrorMessage(message: string): string {
  if (message.toLowerCase().includes("wait a moment")) {
    return "Quick Match was just cancelled. Try again in a moment.";
  }
  if (
    message.toLowerCase().includes("fetch") ||
    message.toLowerCase().includes("network")
  ) {
    return "Quick Match could not reach the server. Check your connection and retry.";
  }
  return "Quick Match is temporarily unavailable. Retry in a moment.";
}

export function QuickMatchClient() {
  const router = useRouter();
  const { state: auth, supabase, retry } = useAnonymousAuth();
  const [queue, setQueue] = useState<RankedQueueState | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [connectionLabel, setConnectionLabel] = useState("Connecting…");
  const startedRef = useRef(false);

  const acceptQueueState = useCallback(
    (next: RankedQueueState | undefined) => {
      if (!next) return;
      setQueue(next);
      setClockOffsetMs(Date.parse(next.server_now) - Date.now());
      if (next.match_id && next.queue_status === "matched") {
        router.replace(`/ranked/${next.match_id}`);
      }
    },
    [router],
  );

  const enterQueue = useCallback(async () => {
    if (!supabase || auth.status !== "ready") return;
    const { data, error: queueError } =
      await supabase.rpc("enter_ranked_queue");
    if (queueError || !data?.[0]) {
      setError(
        queueErrorMessage(
          queueError?.message ?? "No queue state was returned.",
        ),
      );
      return;
    }
    setError(null);
    acceptQueueState(data[0]);
  }, [acceptQueueState, auth.status, supabase]);

  useEffect(() => {
    if (auth.status !== "ready" || !supabase || startedRef.current) return;
    startedRef.current = true;
    void enterQueue();
  }, [auth.status, enterQueue, supabase]);

  useEffect(() => {
    const updateOnline = () => {
      setIsOnline(navigator.onLine);
      if (!navigator.onLine) setConnectionLabel("Offline");
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    updateOnline();
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    if (
      auth.status !== "ready" ||
      !supabase ||
      !isOnline ||
      queue?.queue_status !== "waiting"
    ) {
      return;
    }

    let active = true;
    const refresh = async (heartbeat: boolean) => {
      const { data, error: refreshError } = heartbeat
        ? await supabase.rpc("heartbeat_ranked_queue")
        : await supabase.rpc("get_ranked_queue_state");
      if (!active) return;
      if (refreshError) {
        setError(queueErrorMessage(refreshError.message));
        return;
      }
      acceptQueueState(data?.[0]);
    };

    const pollId = window.setInterval(() => void refresh(false), 4_000);
    const heartbeatId = window.setInterval(
      () => void refresh(true),
      QUEUE_HEARTBEAT_INTERVAL_MS,
    );
    const channel = supabase
      .channel(`ranked-queue:${auth.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ranked_queue",
          filter: `user_id=eq.${auth.user.id}`,
        },
        () => void refresh(false),
      )
      .subscribe((status) => {
        if (!active) return;
        setConnectionLabel(
          status === "SUBSCRIBED" ? "Live search" : "Reconnecting…",
        );
      });

    return () => {
      active = false;
      window.clearInterval(pollId);
      window.clearInterval(heartbeatId);
      void supabase.removeChannel(channel);
    };
  }, [acceptQueueState, auth, isOnline, queue?.queue_status, supabase]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setTick(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, []);

  async function cancelQueue() {
    if (!supabase || queue?.queue_status !== "waiting" || !isOnline) return;
    setIsCancelling(true);
    const { error: cancelError } = await supabase.rpc("cancel_ranked_queue");
    setIsCancelling(false);
    if (cancelError) {
      setError(queueErrorMessage(cancelError.message));
      return;
    }
    router.replace("/");
  }

  const databaseNowMs = tick + clockOffsetMs;
  const waitedMs = queue
    ? Math.max(0, databaseNowMs - Date.parse(queue.joined_at))
    : 0;
  const gap = allowedRatingGap(waitedMs);

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.statusCard}>
        <p className={styles.kicker}>Ranked Quick Match</p>
        {auth.status === "loading" ? (
          <>
            <h1>Preparing your guest.</h1>
            <p>{auth.message}</p>
          </>
        ) : auth.status !== "ready" ? (
          <>
            <h1>Quick Match is offline.</h1>
            <p role="alert">{auth.message}</p>
            <div className={styles.actions}>
              {auth.status === "error" ? (
                <button type="button" onClick={retry}>
                  Retry
                </button>
              ) : null}
              <Link href="/">Return to menu</Link>
            </div>
          </>
        ) : (
          <>
            <div className={styles.livePill} role="status">
              <i aria-hidden="true" />
              {isOnline ? connectionLabel : "Offline"} · {auth.displayName}
            </div>
            <h1>Finding your rival.</h1>
            <div className={styles.searchPulse} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <dl className={styles.queueFacts}>
              <div>
                <dt>Rating</dt>
                <dd>{queue?.rating_snapshot ?? "—"}</dd>
              </div>
              <div>
                <dt>Search time</dt>
                <dd>{Math.floor(waitedMs / 1_000)}s</dd>
              </div>
              <div>
                <dt>Rating range</dt>
                <dd>{gap === Number.POSITIVE_INFINITY ? "Any" : `±${gap}`}</dd>
              </div>
            </dl>
            <p className={styles.supporting}>
              The range widens every ten seconds and opens to any opponent after{" "}
              {OPEN_MATCH_WAIT_MS / 1_000} seconds. One shared board starts five
              seconds after a match is found.
            </p>
            {!isOnline ? (
              <div className={styles.error} role="status">
                <p>
                  You are offline. The database keeps your last queue state, but
                  matchmaking resumes only after you reconnect.
                </p>
              </div>
            ) : null}
            {error ? (
              <div className={styles.error} role="alert">
                <p>{error}</p>
                <button type="button" onClick={enterQueue}>
                  Retry search
                </button>
              </div>
            ) : null}
            <button
              className={styles.secondaryButton}
              disabled={
                isCancelling || !isOnline || queue?.queue_status !== "waiting"
              }
              type="button"
              onClick={cancelQueue}
            >
              {isCancelling ? "Cancelling…" : "Cancel search"}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
