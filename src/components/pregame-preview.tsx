"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";

import type { LetterBoard } from "@/game/types";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";

import styles from "./pregame-preview.module.css";

export function PregamePreview({
  board,
  columns,
  matchId,
  participantCount,
  rerollUsed,
  seconds,
  supabase,
  onChanged,
}: {
  board: LetterBoard;
  columns: number;
  matchId: string;
  participantCount: number;
  rerollUsed: boolean;
  seconds: number | null;
  supabase: BrowserSupabaseClient;
  onChanged: () => Promise<void>;
}) {
  const [approvals, setApprovals] = useState(0);
  const [declines, setDeclines] = useState(0);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadVotes = useCallback(async () => {
    const { data } = await supabase
      .from("match_reroll_votes")
      .select("approve")
      .eq("match_id", matchId);
    setApprovals((data ?? []).filter((vote) => vote.approve).length);
    setDeclines((data ?? []).filter((vote) => !vote.approve).length);
  }, [matchId, supabase]);

  useEffect(() => {
    const initialLoadId = window.setTimeout(() => void loadVotes(), 0);
    const pollId = window.setInterval(() => void loadVotes(), 2_000);
    const channel = supabase
      .channel(`reroll-votes:${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "match_reroll_votes",
          filter: `match_id=eq.${matchId}`,
        },
        () => void loadVotes(),
      )
      .subscribe();
    return () => {
      window.clearTimeout(initialLoadId);
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [loadVotes, matchId, supabase]);

  async function vote(approve: boolean) {
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("vote_match_reroll", {
      p_match_id: matchId,
      p_approve: approve,
    });
    setIsWorking(false);
    if (error || !data?.[0]) {
      setMessage("That reroll vote could not be recorded.");
      return;
    }
    const state = data[0];
    setApprovals(state.approvals);
    setDeclines(state.declines);
    setMessage(
      state.reroll_used
        ? "Unanimous reroll approved. Previewing the new board."
        : approve
          ? "Reroll vote recorded."
          : "Reroll declined. This board will start as shown.",
    );
    await onChanged();
  }

  return (
    <section className={styles.preview} aria-label="Pregame board preview">
      <div
        className={styles.board}
        style={{ "--preview-columns": columns } as CSSProperties}
      >
        {board.flat().map((letter, index) =>
          letter ? (
            <span className={styles.tile} key={index}>
              {letter}
            </span>
          ) : (
            <span className={styles.gap} key={index} aria-hidden="true" />
          ),
        )}
      </div>
      <div className={styles.facts}>
        <span>{seconds ?? 0}s until start</span>
        <span>
          {approvals}/{participantCount} reroll approvals
        </span>
        {declines > 0 ? <span>Reroll declined</span> : null}
      </div>
      {!rerollUsed && !declines && (seconds ?? 0) > 0 ? (
        <div className={styles.actions}>
          <button
            disabled={isWorking}
            onClick={() => void vote(true)}
            type="button"
          >
            Request / approve reroll
          </button>
          <button
            disabled={isWorking}
            onClick={() => void vote(false)}
            type="button"
          >
            Keep this board
          </button>
        </div>
      ) : null}
      {message ? (
        <p className={styles.message} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
