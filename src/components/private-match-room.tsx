"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateBoardFromSeed } from "@/game/board";
import type { ScoredWordSubmission, WordPathSubmission } from "@/game/types";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import { calculateServerClockOffset } from "@/multiplayer/state";
import {
  compareMatchResults,
  deriveMultiplayerView,
  getMatchEndTimeMs,
} from "@/multiplayer/state";
import type {
  MatchPlayerRecord,
  MatchRecord,
  PrivateRoomState,
  RoomParticipant,
} from "@/multiplayer/types";
import {
  parseResultRequest,
  validateMatchSubmissions,
} from "@/multiplayer/validation";

import { AppHeader } from "./app-header";
import styles from "./private-match-room.module.css";
import { LetterRushGame } from "./letter-rush-game";

type PrivateMatchRoomProps = {
  currentUserId: string;
  initialRoomCode: string;
  matchId: string;
  onExit: () => void;
  supabase: BrowserSupabaseClient;
};

const DRAFT_PREFIX = "letter-rush:match-draft:";
const STALE_RESULT_WAIT_MS = 45_000;

function draftKey(matchId: string, userId: string) {
  return `${DRAFT_PREFIX}${matchId}:${userId}`;
}

function parseValidatedWords(
  value: MatchPlayerRecord["validated_words"],
): string[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (
      entry &&
      typeof entry === "object" &&
      "word" in entry &&
      typeof entry.word === "string"
    ) {
      return [entry.word];
    }
    return [];
  });
}

function loadDraft(
  matchId: string,
  userId: string,
  board: ReturnType<typeof generateBoardFromSeed>,
): ScoredWordSubmission[] {
  try {
    const raw = window.localStorage.getItem(draftKey(matchId, userId));
    if (!raw) return [];

    const parsed = parseResultRequest({
      matchId,
      submissions: JSON.parse(raw),
    });
    if (!parsed.isValid) return [];

    const validation = validateMatchSubmissions(board, parsed.submissions);
    return validation.isValid ? validation.submissions : [];
  } catch {
    return [];
  }
}

export function PrivateMatchRoom({
  currentUserId,
  initialRoomCode,
  matchId,
  onExit,
  supabase,
}: PrivateMatchRoomProps) {
  const [room, setRoom] = useState<PrivateRoomState | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("Connecting…");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [roundSubmissions, setRoundSubmissions] = useState<
    ScoredWordSubmission[]
  >([]);
  const submissionInFlightRef = useRef(false);
  const activationRequestedRef = useRef(false);
  const staleFinalizationRequestedRef = useRef(false);

  const fetchRoom = useCallback(async () => {
    const [
      { data: matchData, error: matchError },
      { data: playerData, error: playerError },
      { data: serverNow, error: timeError },
    ] = await Promise.all([
      supabase.from("matches").select("*").eq("id", matchId).maybeSingle(),
      supabase
        .from("match_players")
        .select("*")
        .eq("match_id", matchId)
        .order("player_number"),
      supabase.rpc("get_server_time"),
    ]);

    if (matchError || playerError || timeError || !matchData || !serverNow) {
      throw new Error(
        matchError?.message ??
          playerError?.message ??
          timeError?.message ??
          "This room was not found or is no longer available.",
      );
    }

    const players = (playerData ?? []) as MatchPlayerRecord[];
    const playerIds = players.map((player) => player.player_user_id);
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", playerIds);

    if (profileError) throw profileError;

    const names = new Map(
      (profiles ?? []).map((profile) => [profile.id, profile.display_name]),
    );
    const participants: RoomParticipant[] = players.map((player) => ({
      ...player,
      displayName:
        names.get(player.player_user_id) ?? `Player ${player.player_number}`,
    }));

    setClockOffsetMs(calculateServerClockOffset(serverNow));
    setRoom({
      match: matchData as MatchRecord,
      players: participants,
      serverNow,
    });
    setError(null);
    setIsLoading(false);
  }, [matchId, supabase]);

  useEffect(() => {
    let isActive = true;

    async function load() {
      try {
        await fetchRoom();
      } catch (loadError) {
        if (!isActive) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The private room could not be loaded.",
        );
        setIsLoading(false);
      }
    }

    void load();
    const pollId = window.setInterval(() => void load(), 5_000);

    const channel = supabase
      .channel(`private-match:${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "matches",
          filter: `id=eq.${matchId}`,
        },
        () => void load(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "match_players",
          filter: `match_id=eq.${matchId}`,
        },
        () => void load(),
      )
      .subscribe((status) => {
        if (!isActive) return;
        setConnectionLabel(status === "SUBSCRIBED" ? "Live" : "Reconnecting…");
      });

    return () => {
      isActive = false;
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [fetchRoom, matchId, supabase]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockTick(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, []);

  const authoritativeNowMs = clockTick + clockOffsetMs;
  const view = room
    ? deriveMultiplayerView({
        match: room.match,
        players: room.players,
        currentUserId,
        serverNowMs: authoritativeNowMs,
      })
    : null;
  const currentPlayer = room?.players.find(
    (player) => player.player_user_id === currentUserId,
  );
  const opponent = room?.players.find(
    (player) => player.player_user_id !== currentUserId,
  );
  const board = useMemo(
    () => (room ? generateBoardFromSeed(room.match.board_seed) : null),
    [room],
  );

  useEffect(() => {
    if (
      !room ||
      view !== "playing" ||
      room.match.status !== "starting" ||
      activationRequestedRef.current
    ) {
      return;
    }

    activationRequestedRef.current = true;
    void (async () => {
      try {
        await supabase.rpc("activate_private_match", {
          p_match_id: matchId,
        });
        await fetchRoom();
      } catch {
        activationRequestedRef.current = false;
      }
    })();
  }, [fetchRoom, matchId, room, supabase, view]);

  const submitResults = useCallback(
    async (submissions: readonly WordPathSubmission[]) => {
      if (submissionInFlightRef.current) return;

      submissionInFlightRef.current = true;
      setIsSubmitting(true);
      setError(null);

      try {
        const response = await fetch("/api/matches/results", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ matchId, submissions }),
        });
        const body = (await response.json()) as {
          error?: string;
          message?: string;
        };

        if (!response.ok) {
          throw new Error(body.error ?? "Your result could not be validated.");
        }

        window.localStorage.removeItem(draftKey(matchId, currentUserId));
        setNotice(body.message ?? "Result validated.");
        await fetchRoom();
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Your result could not be submitted.",
        );
        submissionInFlightRef.current = false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [currentUserId, fetchRoom, matchId],
  );

  const initialDraft = useMemo(
    () => (board ? loadDraft(matchId, currentUserId, board) : []),
    [board, currentUserId, matchId],
  );
  const submissionPayload = useMemo(
    () =>
      (roundSubmissions.length > 0 ? roundSubmissions : initialDraft).map(
        ({ word, path }) => ({ word, path }),
      ),
    [initialDraft, roundSubmissions],
  );

  useEffect(() => {
    if (
      view !== "submitting" ||
      currentPlayer?.finished_at ||
      submissionInFlightRef.current
    ) {
      return;
    }

    void submitResults(submissionPayload);
  }, [currentPlayer?.finished_at, submissionPayload, submitResults, view]);

  useEffect(() => {
    if (
      !room ||
      (view !== "waiting-for-opponent" && view !== "submitting") ||
      staleFinalizationRequestedRef.current
    ) {
      return;
    }

    const endTimeMs = getMatchEndTimeMs(room.match);
    if (
      endTimeMs === null ||
      authoritativeNowMs < endTimeMs + STALE_RESULT_WAIT_MS
    ) {
      return;
    }

    staleFinalizationRequestedRef.current = true;
    void (async () => {
      try {
        await supabase.rpc("finalize_stale_match", {
          p_match_id: matchId,
        });
        await fetchRoom();
      } catch {
        staleFinalizationRequestedRef.current = false;
      }
    })();
  }, [authoritativeNowMs, fetchRoom, matchId, room, supabase, view]);

  function saveDraft(submissions: readonly ScoredWordSubmission[]) {
    setRoundSubmissions([...submissions]);
    window.localStorage.setItem(
      draftKey(matchId, currentUserId),
      JSON.stringify(submissions.map(({ word, path }) => ({ word, path }))),
    );
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(successMessage);
    } catch {
      setError("Clipboard access was blocked. Select and copy the code.");
    }
  }

  async function cancelMatch() {
    const { error: cancelError } = await supabase.rpc("cancel_private_match", {
      p_match_id: matchId,
    });

    if (cancelError) {
      setError(cancelError.message);
      return;
    }

    await fetchRoom();
  }

  if (isLoading) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard} role="status">
          <p className={styles.kicker}>Private match</p>
          <h1>Loading room…</h1>
          <p>Restoring the authoritative match state.</p>
        </section>
      </main>
    );
  }

  if (!room || !currentPlayer) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>Private match unavailable</p>
          <h1>Room not found.</h1>
          <p role="alert">{error}</p>
          <button type="button" onClick={onExit}>
            Return to menu
          </button>
        </section>
      </main>
    );
  }

  const roomCode = room.match.room_code || initialRoomCode;
  const inviteUrl =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}${window.location.pathname}?room=${roomCode}`;

  if (view === "playing" && board && room.match.scheduled_start_at) {
    return (
      <LetterRushGame
        board={board}
        initialSubmissions={initialDraft}
        mode="multiplayer"
        onExit={onExit}
        onProgress={saveDraft}
        onRoundComplete={submitResults}
        roundDurationSeconds={room.match.round_duration_seconds}
        scheduledStartAt={room.match.scheduled_start_at}
        serverClockOffsetMs={clockOffsetMs}
      />
    );
  }

  const countdownSeconds = room.match.scheduled_start_at
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(room.match.scheduled_start_at) - authoritativeNowMs) /
            1_000,
        ),
      )
    : null;
  const isHost = room.match.host_user_id === currentUserId;
  const canCancel =
    isHost &&
    (view === "waiting" || view === "countdown") &&
    (!room.match.scheduled_start_at ||
      authoritativeNowMs < Date.parse(room.match.scheduled_start_at));

  if (view === "results") {
    const currentScore = currentPlayer.validated_score ?? 0;
    const opponentScore = opponent?.validated_score ?? 0;
    const outcome =
      currentPlayer.result_status === "tie"
        ? "tie"
        : currentPlayer.result_status === "winner"
          ? "win"
          : currentPlayer.result_status === "loser" ||
              currentPlayer.result_status === "forfeit"
            ? "loss"
            : compareMatchResults(currentScore, opponentScore);

    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.resultsCard}>
          <p className={styles.kicker}>Validated result</p>
          <h1>
            {outcome === "win"
              ? "You win."
              : outcome === "loss"
                ? "You lose."
                : "It’s a tie."}
          </h1>
          <p className={styles.resultLead}>
            The server regenerated the board and checked every submitted tile
            path before scoring.
          </p>

          <div className={styles.resultGrid}>
            {[currentPlayer, opponent].filter(Boolean).map((player) => (
              <article
                className={
                  player?.player_user_id === currentUserId
                    ? styles.currentResult
                    : ""
                }
                key={player?.player_user_id}
              >
                <span>
                  {player?.player_user_id === currentUserId
                    ? "You"
                    : "Opponent"}
                </span>
                <h2>{player?.displayName}</h2>
                <strong>
                  {(player?.validated_score ?? 0).toLocaleString()}
                </strong>
                <div className={styles.wordChips}>
                  {parseValidatedWords(player?.validated_words ?? []).map(
                    (word) => (
                      <small key={word}>{word}</small>
                    ),
                  )}
                  {parseValidatedWords(player?.validated_words ?? []).length ===
                  0 ? (
                    <small>No accepted words</small>
                  ) : null}
                </div>
              </article>
            ))}
          </div>

          <button type="button" onClick={onExit}>
            Return to menu
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.statusCard}>
        <div className={styles.roomMeta}>
          <span>{connectionLabel}</span>
          <span>Room {roomCode}</span>
        </div>

        {view === "cancelled" ? (
          <>
            <p className={styles.kicker}>Match cancelled</p>
            <h1>This room is closed.</h1>
            <button type="button" onClick={onExit}>
              Return to menu
            </button>
          </>
        ) : view === "waiting" ? (
          <>
            <p className={styles.kicker}>Private match created</p>
            <h1>Bring a friend.</h1>
            <p className={styles.statusLead}>
              Share this code. The room stays private and starts only when a
              second anonymous player joins.
            </p>
            <output className={styles.roomCode} aria-label="Room code">
              {roomCode}
            </output>
            <div className={styles.actionRow}>
              <button
                type="button"
                onClick={() => copyText(roomCode, "Room code copied.")}
              >
                Copy code
              </button>
              <button
                type="button"
                onClick={() =>
                  copyText(inviteUrl, "Private invite link copied.")
                }
              >
                Copy invite link
              </button>
            </div>
            <div className={styles.players}>
              <span>
                <i aria-hidden="true" />
                {currentPlayer.displayName}
              </span>
              <span className={styles.searching}>
                <i aria-hidden="true" />
                Waiting for opponent…
              </span>
            </div>
          </>
        ) : view === "countdown" ? (
          <>
            <p className={styles.kicker}>Opponent connected</p>
            <h1>Get ready.</h1>
            <div className={styles.countdown} role="timer">
              {countdownSeconds}
            </div>
            <p className={styles.statusLead}>
              {currentPlayer.displayName} vs. {opponent?.displayName}. Both
              boards begin at the database-scheduled start time.
            </p>
          </>
        ) : (
          <>
            <p className={styles.kicker}>
              {isSubmitting ? "Validating your result" : "Result submitted"}
            </p>
            <h1>
              {isSubmitting ? "Checking paths…" : "Waiting on your friend."}
            </h1>
            <p className={styles.statusLead}>
              {opponent?.finished_at
                ? `${opponent.displayName} has finished.`
                : `${opponent?.displayName ?? "Your opponent"} is still finishing the round.`}
            </p>
          </>
        )}

        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            {view === "submitting" ? (
              <button
                type="button"
                onClick={() => submitResults(submissionPayload)}
              >
                Retry submission
              </button>
            ) : null}
          </div>
        ) : null}

        {canCancel ? (
          <button
            className={styles.cancelButton}
            type="button"
            onClick={cancelMatch}
          >
            Cancel match
          </button>
        ) : null}
      </section>
    </main>
  );
}
