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
type MyPreviewVotes =
  Database["public"]["Functions"]["get_my_match_preview_votes"]["Returns"][number];

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

const PREVIEW_POLL_MS = 750;
const MAXIMUM_RETRY_DELAY_MS = 8_000;

export function previewRetryDelay(attempt: number): number {
  return Math.min(
    MAXIMUM_RETRY_DELAY_MS,
    300 * 2 ** Math.min(5, Math.max(0, attempt - 1)),
  );
}

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
  if (message?.includes("three-reroll limit"))
    return "This match has used all three rerolls.";
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
  const [myVotes, setMyVotes] = useState<MyPreviewVotes | null>(null);
  const [workingAction, setWorkingAction] = useState<"reroll" | "skip" | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transitionRevision, setTransitionRevision] = useState<number | null>(
    null,
  );
  const mountedRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const loadPreviewRef = useRef<(explicitRetry?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );
  const actionInFlightRef = useRef<"reroll" | "skip" | null>(null);
  const pollingStoppedRef = useRef(false);
  const lastReportedLoadErrorRef = useRef<SupabaseErrorKind | null>(null);
  const boardRevisionRef = useRef(boardRevision);
  const transitionRevisionRef = useRef(transitionRevision);

  useEffect(() => {
    boardRevisionRef.current = boardRevision;
  }, [boardRevision]);

  useEffect(() => {
    transitionRevisionRef.current = transitionRevision;
  }, [transitionRevision]);

  const applyPreview = useCallback((candidate: PreviewState) => {
    setPreview((current) =>
      isNewerPreviewState(candidate, current) ? candidate : current,
    );
  }, []);

  const loadPreview = useCallback(
    (explicitRetry = false): Promise<void> => {
      if (explicitRetry) {
        pollingStoppedRef.current = false;
        retryAttemptRef.current = 0;
        setLoadError(null);
        setMessage(null);
      }
      if (pollingStoppedRef.current && !explicitRetry) return Promise.resolve();
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        return refreshInFlightRef.current;
      }

      const request = (async () => {
        const [previewResponse, votesResponse] = await Promise.all([
          supabase.rpc("get_match_preview_state", { p_match_id: matchId }),
          supabase.rpc("get_my_match_preview_votes", { p_match_id: matchId }),
        ]);
        const { data, error: previewError } = previewResponse;
        const { data: votesData, error: votesError } = votesResponse;
        const error = previewError ?? votesError;
        if (!mountedRef.current) return;

        if (error || !data?.[0]) {
          const classified = error
            ? classifySupabaseError(error)
            : { kind: "unknown" as const, retryable: true };
          if (error && lastReportedLoadErrorRef.current !== classified.kind) {
            reportSupabaseError(error, {
              feature: "pregame preview",
              rpcName: "get_match_preview_state",
            });
            lastReportedLoadErrorRef.current = classified.kind;
          }
          if (!classified.retryable) {
            pollingStoppedRef.current = classified.kind === "missing_rpc";
            setLoadError(
              error
                ? friendlyPreviewError(error, "get_match_preview_state")
                : "The shared preview returned no board state.",
            );
            return;
          }

          // A short outage should be invisible to players. Keep the last
          // authoritative snapshot and retry with a bounded backoff.
          retryAttemptRef.current += 1;
          const delay = previewRetryDelay(retryAttemptRef.current);
          if (retryTimerRef.current !== null)
            window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            void loadPreviewRef.current();
          }, delay);
          return;
        }

        retryAttemptRef.current = 0;
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        setLoadError(null);
        lastReportedLoadErrorRef.current = null;
        const waitingForRevision = transitionRevisionRef.current;
        if (
          waitingForRevision !== null &&
          boardRevisionRef.current < waitingForRevision
        ) {
          void onChanged().catch(() => undefined);
        }
        applyPreview(data[0]);
        const nextVotes = votesData?.[0];
        if (nextVotes) {
          setMyVotes((current) => {
            if (!current) return nextVotes;
            if (nextVotes.board_revision !== current.board_revision) {
              return nextVotes.board_revision > current.board_revision
                ? nextVotes
                : current;
            }
            return Date.parse(nextVotes.server_now) >=
              Date.parse(current.server_now)
              ? nextVotes
              : current;
          });
        }
      })().finally(() => {
        refreshInFlightRef.current = null;
        if (refreshQueuedRef.current && mountedRef.current) {
          refreshQueuedRef.current = false;
          void loadPreviewRef.current();
        }
      });
      refreshInFlightRef.current = request;
      return request;
    },
    [applyPreview, matchId, onChanged, supabase],
  );

  useEffect(() => {
    loadPreviewRef.current = loadPreview;
  }, [loadPreview]);

  useEffect(() => {
    mountedRef.current = true;
    pollingStoppedRef.current = false;
    retryAttemptRef.current = 0;
    const initialLoadId = window.setTimeout(() => void loadPreview(), 0);
    const pollId = window.setInterval(() => {
      if (retryTimerRef.current === null) void loadPreview();
    }, PREVIEW_POLL_MS);
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
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "match_reroll_votes",
          filter: `match_id=eq.${matchId}`,
        },
        () => void loadPreview(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "match_countdown_skip_votes",
          filter: `match_id=eq.${matchId}`,
        },
        () => void loadPreview(),
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialLoadId);
      window.clearInterval(pollId);
      if (retryTimerRef.current !== null)
        window.clearTimeout(retryTimerRef.current);
      void supabase.removeChannel(channel);
    };
  }, [loadPreview, matchId, supabase]);

  async function voteReroll() {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = "reroll";
    setWorkingAction("reroll");
    setMessage(null);
    const currentRevision = preview?.board_revision ?? boardRevision;
    const { data, error } = await supabase.rpc("vote_match_reroll_cycle", {
      p_match_id: matchId,
      p_board_revision: currentRevision,
      p_approve: true,
    });
    actionInFlightRef.current = null;
    setWorkingAction(null);

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
    if (next.board_revision > currentRevision) {
      setTransitionRevision(next.board_revision);
      applyPreview(next);
      setMyVotes(null);
      setMessage("Both players voted. Loading the new board…");
      try {
        await onChanged();
        setMessage("New board ready.");
      } catch {
        setMessage(
          "The new board was approved. Reconnecting to the shared preview…",
        );
      }
      return;
    }

    applyPreview(next);
    setMyVotes((current) => ({
      board_revision: currentRevision,
      reroll_sequence: next.reroll_sequence,
      reroll_voted: true,
      skip_voted: current?.skip_voted ?? false,
      server_now: next.server_now,
    }));
    setMessage(null);
  }

  async function skipCountdown() {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = "skip";
    setWorkingAction("skip");
    setMessage(null);
    const currentRevision = preview?.board_revision ?? boardRevision;
    const { data, error } = await supabase.rpc("vote_match_countdown_skip", {
      p_match_id: matchId,
      p_board_revision: currentRevision,
    });
    actionInFlightRef.current = null;
    setWorkingAction(null);

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
    setMyVotes((current) => ({
      board_revision: currentRevision,
      reroll_sequence: next.reroll_sequence,
      reroll_voted: current?.reroll_voted ?? false,
      skip_voted: true,
      server_now: next.server_now,
    }));
    if (next.skip_approvals >= next.participant_count) {
      setMessage("Everyone agreed. Starting…");
      try {
        await onChanged();
      } catch {
        setMessage("The shared start time was set. Reconnecting…");
      }
    } else {
      setMessage(null);
    }
  }

  const displayedParticipants = preview?.participant_count ?? participantCount;
  const displayedApprovals = preview?.reroll_approvals ?? 0;
  const skipApprovals = preview?.skip_approvals ?? 0;
  const completedRerolls = preview?.reroll_sequence ?? 0;
  const rerollLimitReached = completedRerolls >= 3;
  const rerollVoteSubmitted =
    myVotes?.board_revision === (preview?.board_revision ?? boardRevision) &&
    myVotes.reroll_voted;
  const skipVoteSubmitted =
    myVotes?.board_revision === (preview?.board_revision ?? boardRevision) &&
    myVotes.skip_voted;
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
          Reroll votes {displayedApprovals}/{displayedParticipants}
        </span>
        <span>Rerolls {Math.min(3, completedRerolls)}/3</span>
        <span>
          Skip countdown {skipApprovals}/{displayedParticipants}
        </span>
      </div>

      {votingOpen ? (
        <div className={styles.actions}>
          <button
            aria-busy={workingAction === "reroll"}
            disabled={
              workingAction !== null ||
              rerollVoteSubmitted ||
              rerollLimitReached
            }
            onClick={() => void voteReroll()}
            type="button"
          >
            Reroll
          </button>
          <button
            aria-busy={workingAction === "skip"}
            disabled={workingAction !== null || skipVoteSubmitted}
            onClick={() => void skipCountdown()}
            type="button"
          >
            Skip Countdown
          </button>
        </div>
      ) : null}

      {rerollVoteSubmitted || skipVoteSubmitted || rerollLimitReached ? (
        <p className={styles.message} role="status">
          {rerollLimitReached
            ? "All 3 rerolls used."
            : [
                rerollVoteSubmitted
                  ? `Reroll vote submitted. Waiting for ${
                      displayedParticipants === 2
                        ? "the other player"
                        : "the remaining players"
                    }.`
                  : null,
                skipVoteSubmitted
                  ? `Skip vote submitted. Waiting for ${
                      displayedParticipants === 2
                        ? "the other player"
                        : "the remaining players"
                    }.`
                  : null,
              ]
                .filter(Boolean)
                .join(" ")}
        </p>
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
