"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useAnonymousAuth } from "@/hooks/use-anonymous-auth";
import { getSupabaseEnvironment } from "@/lib/supabase/config";
import { RANKED_RULESET, RANKED_RULESET_VERSION } from "@/ranked/ruleset";
import type { RankedProfile, RankedQueueState } from "@/ranked/types";

import { AppHeader } from "./app-header";
import styles from "./ranked.module.css";

export function RankedDiagnostics() {
  const environment = getSupabaseEnvironment();
  const { state: auth, supabase } = useAnonymousAuth();
  const [queue, setQueue] = useState<RankedQueueState | null>(null);
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase || auth.status !== "ready") return;
    const [
      { data: queueData, error: queueError },
      { data: profileData, error: profileError },
    ] = await Promise.all([
      supabase.rpc("get_ranked_queue_state"),
      supabase.rpc("get_current_ranked_profile"),
    ]);
    if (queueError || profileError) {
      setError(
        queueError?.message ??
          profileError?.message ??
          "Diagnostics could not be loaded.",
      );
      return;
    }
    setQueue(queueData?.[0] ?? null);
    setProfile(profileData?.[0] ?? null);
    setError(null);
  }, [auth.status, supabase]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.page}>
        <p className={styles.kicker}>Development only</p>
        <h1>Ranked diagnostics</h1>
        <p>
          This view intentionally omits auth UUIDs, cookies, tokens, and
          credentials.
        </p>
        {auth.status === "ready" ? (
          <>
            <dl className={styles.profileStats}>
              <div>
                <dt>Player</dt>
                <dd>{profile?.public_profile_id ?? "—"}</dd>
              </div>
              <div>
                <dt>Rating</dt>
                <dd>{profile?.current_rating ?? "—"}</dd>
              </div>
              <div>
                <dt>Queue</dt>
                <dd>{queue?.queue_status ?? "idle"}</dd>
              </div>
              <div>
                <dt>Match</dt>
                <dd>{queue?.match_id ?? "none"}</dd>
              </div>
              <div>
                <dt>Games</dt>
                <dd>{profile?.games_played ?? "—"}</dd>
              </div>
              <div>
                <dt>Rules</dt>
                <dd>{RANKED_RULESET_VERSION}</dd>
              </div>
              <div>
                <dt>Dictionary</dt>
                <dd>{RANKED_RULESET.dictionaryVersion}</dd>
              </div>
              <div>
                <dt>Generator</dt>
                <dd>{RANKED_RULESET.boardGenerationVersion}</dd>
              </div>
              <div>
                <dt>Scoring</dt>
                <dd>{RANKED_RULESET.scoringRulesVersion}</dd>
              </div>
              <div>
                <dt>Supabase</dt>
                <dd>{environment.isConfigured ? "configured" : "missing"}</dd>
              </div>
            </dl>
            <button type="button" onClick={refresh}>
              Refresh
            </button>
          </>
        ) : (
          <p>{auth.message}</p>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <Link href="/">Menu</Link>
        </div>
      </section>
    </main>
  );
}
