"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { LetterBoard } from "@/game/types";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import {
  classifySupabaseError,
  reportSupabaseError,
  supabaseErrorMessage,
  type SupabaseErrorKind,
} from "@/lib/supabase/errors";

import styles from "./pregame-preview.module.css";

export type PreviewState =
  Database["public"]["Functions"]["get_match_preview_state"]["Returns"][number];

export function isNewerPreviewState(
  candidate: PreviewState,
  current: PreviewState | null,
): boolean {
  if (!current) return true;
  if (candidate.board_revision !== current.board_revision) {
    return candidate.board_revision > current.board_revision;
  }
  if (candidate.reroll_vote_revision !== current.reroll_vote_revision) {
    return candidate.reroll_vote_revision > current.reroll_vote_revision;
  }
  return Date.parse(candidate.server_now) >= Date.parse(current.server_now);
}

const MAXIMUM_PREVIEW_POLL_ATTEMPTS = 30;

function friendlyPreviewError(error: unknown, rpcName: string): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  if (message?.includes("board changed"))
    return "The board changed. Refreshing the preview.";
  if (message?.includes("Reroll voting is closed"))
    return "Reroll voting has closed for this countdown.";
  if (message?.includes("Countdown voting is closed"))
    return "Countdown voting has closed.";
  if (message?.includes("Finish the reroll vote"))
    return "Finish the reroll vote before skipping the countdown.";
  if (message?.includes("not a participant"))
    return "Only current participants can vote.";
  return supabaseErrorMessage(error, {
    feature: "Pregame controls",
    productionMessage:
      "The shared preview could not be refreshed. You can retry without leaving.",
    rpcName,
  });
}

export function PregamePreview({
  board,
  boardRevision,
  columns,
  matchId,
  participantCount,
  seconds,
  supabase,
  onChanged,
}: {
  board: LetterBoard;
  boardRevision: number;
  columns: number;
  matchId: string;
  participantCount: number;
  seconds: number | null;
  supabase: BrowserSupabaseClient;
  onChanged: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transitionRevision, setTransitionRevision] = useState<number | null>(
    null,
  );
  const requestSequenceRef = useRef(0);
  const pollingStoppedRef = useRef(false);
  const pollAttemptsRef = useRef(0);
  const lastReportedLoadErrorRef = useRef<SupabaseErrorKind | null>(null);

  const applyPreview = useCallback((candidate: PreviewState) => {
    setPreview((current) =>
      isNewerPreviewState(candidate, current) ? candidate : current,
    );
  }, []);

  const loadPreview = useCallback(
    async (explicitRetry = false) => {
      if (pollingStoppedRef.current && !explicitRetry) return;
      if (explicitRetry) {
        pollingStoppedRef.current = false;
        pollAttemptsRef.current = 0;
        setLoadError(null);
      }
      const requestSequence = ++requestSequenceRef.current;
      const { data, error } = await supabase.rpc("get_match_preview_state", {
        p_match_id: matchId,
      });
      if (requestSequence !== requestSequenceRef.current) return;
      if (error || !data?.[0]) {
        if (error) {
          const classified = classifySupabaseError(error);
          setLoadError(friendlyPreviewError(error, "get_match_preview_state"));
          if (lastReportedLoadErrorRef.current !== classified.kind) {
            reportSupabaseError(error, {
              feature: "pregame preview",
              rpcName: "get_match_preview_state",
            });
            lastReportedLoadErrorRef.current = classified.kind;
          }
          if (classified.kind === "missing_rpc") {
            pollingStoppedRef.current = true;
          }
        } else {
          setLoadError("The shared preview returned no board state. Retry.");
        }
        return;
      }
      if (transitionRevision !== null && boardRevision < transitionRevision) {
        return;
      }
      setLoadError(null);
      lastReportedLoadErrorRef.current = null;
      if (explicitRetry) setMessage(null);
      applyPreview(data[0]);
    },
    [applyPreview, boardRevision, matchId, supabase, transitionRevision],
  );

  useEffect(() => {
    pollingStoppedRef.current = false;
    pollAttemptsRef.current = 0;
    const initialLoadId = window.setTimeout(() => void loadPreview(), 0);
    const pollId = window.setInterval(() => {
      if (pollAttemptsRef.current >= MAXIMUM_PREVIEW_POLL_ATTEMPTS) {
        window.clearInterval(pollId);
        return;
      }
      if (pollingStoppedRef.current) return;
      pollAttemptsRef.current += 1;
      void loadPreview();
    }, 1_000);
    const channel = supabase
      .channel(`preview-state:${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "matches",
          filter: `id=eq.${matchId}`,
        },
        () => void loadPreview(),
      )
      .subscribe();

    return () => {
      requestSequenceRef.current += 1;
      window.clearTimeout(initialLoadId);
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [loadPreview, matchId, supabase]);

  async function voteReroll(approve: boolean) {
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("vote_match_reroll_cycle", {
      p_match_id: matchId,
      p_board_revision: boardRevision,
      p_approve: approve,
    });
    setIsWorking(false);

    const next = data?.[0];
    if (error || !next) {
      if (error) {
        const classified = classifySupabaseError(error);
        reportSupabaseError(error, {
          feature: "pregame reroll",
          rpcName: "vote_match_reroll_cycle",
        });
        setMessage(friendlyPreviewError(error, "vote_match_reroll_cycle"));
        if (classified.kind === "missing_rpc") {
          pollingStoppedRef.current = true;
          setLoadError(friendlyPreviewError(error, "vote_match_reroll_cycle"));
          return;
        }
      } else {
        setMessage("The reroll vote returned no shared board state.");
      }
      await loadPreview();
      return;
    }

    setLoadError(null);
    if (next.board_revision > boardRevision) {
      setTransitionRevision(next.board_revision);
      setPreview({
        ...next,
        reroll_status: "pending",
        reroll_approvals: next.participant_count,
        reroll_declines: 0,
      });
      setMessage("Unanimous reroll approved. Loading the new board…");
      try {
        await onChanged();
        setMessage("New board ready. Start another reroll vote if you want.");
      } catch {
        setMessage(
          "The new board was approved. Reconnecting to the shared preview…",
        );
      }
      return;
    }

    applyPreview(next);
    setMessage(
      next.reroll_status === "declined"
        ? "Reroll declined. The current board stays."
        : approve
          ? "Reroll approval recorded."
          : "Reroll declined. The current board stays.",
    );
  }

  async function skipCountdown() {
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("vote_match_countdown_skip", {
      p_match_id: matchId,
      p_board_revision: boardRevision,
    });
    setIsWorking(false);

    const next = data?.[0];
    if (error || !next) {
      if (error) {
        const classified = classifySupabaseError(error);
        reportSupabaseError(error, {
          feature: "pregame countdown",
          rpcName: "vote_match_countdown_skip",
        });
        setMessage(friendlyPreviewError(error, "vote_match_countdown_skip"));
        if (classified.kind === "missing_rpc") {
          pollingStoppedRef.current = true;
          setLoadError(
            friendlyPreviewError(error, "vote_match_countdown_skip"),
          );
          return;
        }
      } else {
        setMessage("The skip vote returned no shared board state.");
      }
      await loadPreview();
      return;
    }
    setLoadError(null);
    applyPreview(next);
    if (next.skip_approvals >= next.participant_count) {
      setMessage("Everyone agreed. Starting…");
      try {
        await onChanged();
      } catch {
        setMessage("The shared start time was set. Reconnecting…");
      }
    } else {
      setMessage("Skip-countdown vote recorded.");
    }
  }

  const displayedParticipants = preview?.participant_count ?? participantCount;
  const displayedApprovals = preview?.reroll_approvals ?? 0;
  const displayedDeclines = preview?.reroll_declines ?? 0;
  const skipApprovals = preview?.skip_approvals ?? 0;
  const rerollPending = preview?.reroll_status === "pending";
  const transitioning =
    transitionRevision !== null && boardRevision < transitionRevision;
  const starting =
    displayedParticipants > 0 && skipApprovals >= displayedParticipants;
  const votingOpen = (seconds ?? 0) > 0 && !starting && !transitioning;

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
        <span>{starting ? "Starting…" : `${seconds ?? 0}s until start`}</span>
        <span>
          Reroll {displayedApprovals}/{displayedParticipants}
        </span>
        <span>
          Skip countdown {skipApprovals}/{displayedParticipants}
        </span>
        {displayedDeclines > 0 ? <span>Reroll declined</span> : null}
      </div>

      {votingOpen ? (
        <div className={styles.actions}>
          <button
            disabled={isWorking}
            onClick={() => void voteReroll(true)}
            type="button"
          >
            {rerollPending ? "Approve reroll" : "Request reroll"}
          </button>
          {rerollPending ? (
            <button
              disabled={isWorking}
              onClick={() => void voteReroll(false)}
              type="button"
            >
              Decline reroll
            </button>
          ) : null}
          <button
            disabled={isWorking || rerollPending}
            onClick={() => void skipCountdown()}
            type="button"
          >
            Skip countdown {skipApprovals}/{displayedParticipants}
          </button>
        </div>
      ) : null}

      {(message ?? loadError) ? (
        <p className={styles.message} role="status">
          {message ?? loadError}
        </p>
      ) : null}
      {loadError ? (
        <div className={styles.actions}>
          <button onClick={() => void loadPreview(true)} type="button">
            Retry preview
          </button>
        </div>
      ) : null}
    </section>
  );
}
