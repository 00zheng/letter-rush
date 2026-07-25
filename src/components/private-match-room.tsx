"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateBoard } from "@/game/board";
import {
  calculateWordScore,
  createWordFromPath,
  validateTilePath,
} from "@/game/logic";
import { validateRuleset, type GameRuleset } from "@/game/ruleset";
import type { ScoredWordSubmission, WordPathSubmission } from "@/game/types";
import { useMatchPresence } from "@/hooks/use-match-presence";
import { useWordOpportunities } from "@/hooks/use-word-opportunities";
import { createInviteUrl } from "@/lib/app-url";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import {
  calculateServerClockOffset,
  deriveMultiplayerView,
  getMatchEndTimeMs,
  rankMatchResults,
} from "@/multiplayer/state";
import type {
  MatchPlayerRecord,
  MatchRecord,
  PrivateRoomState,
  RoomParticipant,
} from "@/multiplayer/types";
import { parseResultRequest } from "@/multiplayer/validation";

import { AppHeader } from "./app-header";
import { LetterRushGame } from "./letter-rush-game";
import { PregamePreview } from "./pregame-preview";
import { PrivateRematchControl } from "./private-rematch-control";
import { TwoPlayerRematchControls } from "./rematch-controls";
import { WordOpportunities } from "./word-opportunities";
import styles from "./private-match-room.module.css";

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

function formatScore(value: number): string {
  return value.toLocaleString("en-US");
}

function parseValidatedWords(
  value: MatchPlayerRecord["validated_words"],
): { word: string; score: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ word: entry, score: calculateWordScore(entry) }];
      }
      if (
        entry &&
        typeof entry === "object" &&
        "word" in entry &&
        typeof entry.word === "string"
      ) {
        return [
          {
            word: entry.word,
            score:
              "score" in entry && typeof entry.score === "number"
                ? entry.score
                : calculateWordScore(entry.word),
          },
        ];
      }
      return [];
    })
    .sort(
      (first, second) =>
        second.score - first.score ||
        second.word.length - first.word.length ||
        first.word.localeCompare(second.word),
    );
}

function loadDraft(
  matchId: string,
  userId: string,
  board: ReturnType<typeof generateBoard>,
  ruleset: GameRuleset,
): ScoredWordSubmission[] {
  try {
    const raw = window.localStorage.getItem(draftKey(matchId, userId));
    if (!raw) return [];

    const parsed = parseResultRequest({
      matchId,
      submissions: JSON.parse(raw),
    });
    if (!parsed.isValid) return [];

    const restored: ScoredWordSubmission[] = [];
    const maximumPathLength = ruleset.activeCells.filter(Boolean).length;
    for (const submission of parsed.submissions) {
      const pathValidation = validateTilePath(submission.path, ruleset);
      if (
        !pathValidation.isValid ||
        submission.path.length > maximumPathLength
      ) {
        return [];
      }

      const word = createWordFromPath(board, submission.path);
      if (word !== submission.word.trim().toUpperCase()) return [];
      restored.push({
        word,
        path: submission.path,
        score: calculateWordScore(word),
      });
    }
    return restored;
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
  const [clockTick, setClockTick] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("Connecting...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [roundSubmissions, setRoundSubmissions] = useState<
    ScoredWordSubmission[]
  >([]);
  const submissionInFlightRef = useRef(false);
  const activationRequestedRef = useRef(false);
  const staleFinalizationRequestedRef = useRef(false);
  const roomRequestSequenceRef = useRef(0);

  const fetchRoom = useCallback(async () => {
    const requestSequence = ++roomRequestSequenceRef.current;
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

    if (requestSequence !== roomRequestSequenceRef.current) return;
    if (matchError || playerError || timeError || !matchData || !serverNow) {
      throw new Error(
        matchError?.message ??
          playerError?.message ??
          timeError?.message ??
          "This private lobby was not found or is no longer available.",
      );
    }
    const players = (playerData ?? []) as MatchPlayerRecord[];
    const playerIds = players.map((player) => player.player_user_id);
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", playerIds);
    if (requestSequence !== roomRequestSequenceRef.current) return;
    if (profileError) throw profileError;

    const names = new Map(
      (profiles ?? []).map((profile) => [profile.id, profile.display_name]),
    );
    const participants: RoomParticipant[] = players.map((player) => ({
      ...player,
      displayName:
        names.get(player.player_user_id) ?? `Player ${player.player_number}`,
    }));
    const receivedAt = Date.now();
    setClockTick(receivedAt);
    setClockOffsetMs(calculateServerClockOffset(serverNow, receivedAt));
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
            : "The private lobby could not be loaded.",
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
        setConnectionLabel(
          status === "SUBSCRIBED" ? "Live" : "Reconnecting...",
        );
      });

    return () => {
      isActive = false;
      roomRequestSequenceRef.current += 1;
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [fetchRoom, matchId, supabase]);

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
    const intervalId = window.setInterval(() => setClockTick(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, []);

  const rulesetValidation = useMemo(
    () => validateRuleset(room?.match.ruleset),
    [room?.match.ruleset],
  );
  const ruleset = rulesetValidation.isValid ? rulesetValidation.ruleset : null;
  const board = useMemo(
    () =>
      room && ruleset ? generateBoard(room.match.board_seed, ruleset) : null,
    [room, ruleset],
  );
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
  const currentPlayerWords = useMemo(
    () =>
      currentPlayer
        ? parseValidatedWords(currentPlayer.validated_words).map(
            (entry) => entry.word,
          )
        : [],
    [currentPlayer],
  );
  const opportunities = useWordOpportunities(
    board,
    ruleset,
    currentPlayerWords,
    view === "results",
    supabase,
    matchId,
  );
  const currentPlayerDeparted =
    currentPlayer?.connection_status === "left" ||
    currentPlayer?.connection_status === "forfeited";
  const shouldWarnBeforeLeaving =
    !currentPlayerDeparted &&
    (room?.match.status === "starting" || room?.match.status === "active");
  useMatchPresence({
    enabled:
      Boolean(currentPlayer && !currentPlayer.finished_at) &&
      (room?.match.status === "starting" || room?.match.status === "active"),
    matchId,
    supabase,
  });

  useEffect(() => {
    if (!shouldWarnBeforeLeaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shouldWarnBeforeLeaving]);

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
      const { error: activationError } = await supabase.rpc(
        "activate_private_match",
        { p_match_id: matchId },
      );
      if (activationError) {
        activationRequestedRef.current = false;
        return;
      }
      await fetchRoom();
    })();
  }, [fetchRoom, matchId, room, supabase, view]);

  const initialDraft = useMemo(
    () =>
      board && ruleset ? loadDraft(matchId, currentUserId, board, ruleset) : [],
    [board, currentUserId, matchId, ruleset],
  );
  const submissionPayload = useMemo(
    () =>
      (roundSubmissions.length > 0 ? roundSubmissions : initialDraft).map(
        ({ word, path }) => ({ word, path }),
      ),
    [initialDraft, roundSubmissions],
  );

  const submitResults = useCallback(
    async (submissions: readonly WordPathSubmission[]) => {
      if (submissionInFlightRef.current || !isOnline) return;
      submissionInFlightRef.current = true;
      setIsSubmitting(true);
      setError(null);

      try {
        const response = await fetch("/api/matches/results", {
          method: "POST",
          cache: "no-store",
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
    [currentUserId, fetchRoom, isOnline, matchId],
  );

  useEffect(() => {
    if (
      view !== "submitting" ||
      currentPlayer?.finished_at ||
      submissionInFlightRef.current ||
      !isOnline
    ) {
      return;
    }
    void submitResults(submissionPayload);
  }, [
    currentPlayer?.finished_at,
    isOnline,
    submissionPayload,
    submitResults,
    view,
  ]);

  useEffect(() => {
    if (
      !room ||
      (view !== "waiting-for-opponent" && view !== "submitting") ||
      staleFinalizationRequestedRef.current ||
      !isOnline
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
      const { error: finalizationError } = await supabase.rpc(
        "finalize_stale_match",
        { p_match_id: matchId },
      );
      if (finalizationError) {
        staleFinalizationRequestedRef.current = false;
        return;
      }
      await fetchRoom();
    })();
  }, [authoritativeNowMs, fetchRoom, isOnline, matchId, room, supabase, view]);

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
      setError("Clipboard access was blocked. Select and copy the room code.");
    }
  }

  async function runRoomAction(
    action: "start" | "cancel" | "leave",
  ): Promise<void> {
    setError(null);
    const result =
      action === "start"
        ? await supabase.rpc("start_private_match", { p_match_id: matchId })
        : action === "cancel"
          ? await supabase.rpc("cancel_private_match", { p_match_id: matchId })
          : await supabase.rpc("leave_private_match", { p_match_id: matchId });

    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (action === "leave") {
      onExit();
      return;
    }
    await fetchRoom();
  }

  async function leaveActivePrivateMatch() {
    if (
      !window.confirm(
        "Leave this private match? You will stop playing, but the remaining players can continue.",
      )
    ) {
      return false;
    }

    const { error: exitError } = await supabase.rpc("exit_current_match", {
      p_match_id: matchId,
    });
    if (exitError) {
      setError("The match exit could not be saved. Please retry.");
      return false;
    }

    window.localStorage.removeItem(draftKey(matchId, currentUserId));
    onExit();
    return true;
  }

  if (isLoading) {
    return (
      <main className={styles.appShell}>
        <AppHeader
          activeMatch={shouldWarnBeforeLeaving}
          onActiveNavigate={leaveActivePrivateMatch}
        />
        <section className={styles.statusCard} role="status">
          <p className={styles.kicker}>Private lobby</p>
          <h1>Loading room...</h1>
          <p>Restoring the authoritative match state.</p>
        </section>
      </main>
    );
  }

  if (!room || !currentPlayer || !ruleset || !board) {
    return (
      <main className={styles.appShell}>
        <AppHeader
          activeMatch={shouldWarnBeforeLeaving}
          onActiveNavigate={leaveActivePrivateMatch}
        />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>Private lobby unavailable</p>
          <h1>Room not found.</h1>
          <p role="alert">
            {error ??
              (rulesetValidation.isValid
                ? "You are not a participant in this room."
                : rulesetValidation.message)}
          </p>
          <button type="button" onClick={onExit}>
            Return to menu
          </button>
        </section>
      </main>
    );
  }

  if (
    room.match.status !== "completed" &&
    (currentPlayer.connection_status === "left" ||
      currentPlayer.connection_status === "forfeited")
  ) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>You left the match</p>
          <h1>The remaining players can continue.</h1>
          <p>
            Your departure is final, so this round cannot accept more words.
          </p>
          <button type="button" onClick={onExit}>
            Return to menu
          </button>
        </section>
      </main>
    );
  }

  const roomCode = room.match.room_code || initialRoomCode;
  const inviteUrl = createInviteUrl(roomCode);
  const isHost = room.match.host_user_id === currentUserId;
  const canStart =
    isHost && view === "waiting" && room.players.length >= 2 && isOnline;
  const canCancel = isHost && view === "waiting" && isOnline;
  const canLeave = !isHost && view === "waiting" && isOnline;

  if (view === "playing" && room.match.scheduled_start_at) {
    return (
      <LetterRushGame
        board={board}
        connectionStatus={isOnline ? connectionLabel : "Offline - draft saved"}
        initialSubmissions={initialDraft}
        mode="multiplayer"
        onExit={leaveActivePrivateMatch}
        onExitHandlesConfirmation
        onProgress={saveDraft}
        onRoundComplete={submitResults}
        roundDurationSeconds={ruleset.roundDurationSeconds}
        ruleset={ruleset}
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

  if (view === "results") {
    const rankings = rankMatchResults(room.players);
    const placementByPlayer = new Map(
      rankings.map((ranking) => [ranking.playerUserId, ranking.placement]),
    );
    const currentPlacement = placementByPlayer.get(currentUserId) ?? 1;
    const outcome =
      currentPlacement === 1
        ? room.match.is_tie
          ? "Tie for first."
          : "You win."
        : `You placed #${currentPlacement}.`;

    return (
      <main className={styles.appShell}>
        <AppHeader
          activeMatch={shouldWarnBeforeLeaving}
          onActiveNavigate={leaveActivePrivateMatch}
        />
        <section className={styles.resultsCard}>
          <p className={styles.kicker}>Validated result</p>
          <h1>{outcome}</h1>
          <p className={styles.resultLead}>
            The server regenerated the versioned board and checked every tile
            path before ranking the lobby.
          </p>
          <div className={styles.resultGrid}>
            {rankings.map((ranking) => {
              const player = room.players.find(
                (candidate) =>
                  candidate.player_user_id === ranking.playerUserId,
              )!;
              return (
                <article
                  className={
                    player.player_user_id === currentUserId
                      ? styles.currentResult
                      : ""
                  }
                  key={player.player_user_id}
                >
                  <span>Place #{ranking.placement}</span>
                  {player.result_status === "forfeit" ? (
                    <span>Left match</span>
                  ) : null}
                  <h2>
                    {player.displayName}
                    {player.player_user_id === currentUserId ? " (you)" : ""}
                  </h2>
                  <strong>{formatScore(ranking.score)}</strong>
                  <div className={styles.wordChips}>
                    {parseValidatedWords(player.validated_words).map(
                      ({ word, score }) => (
                        <small key={word}>
                          {word} · {formatScore(score)}
                        </small>
                      ),
                    )}
                    {parseValidatedWords(player.validated_words).length ===
                    0 ? (
                      <small>No accepted words</small>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <WordOpportunities
            error={opportunities.error}
            isLoading={opportunities.isLoading}
            onRetry={opportunities.retry}
            words={opportunities.words}
          />
          {room.players.length === 2 ? (
            <TwoPlayerRematchControls
              matchId={matchId}
              mode="private"
              supabase={supabase}
            />
          ) : (
            <PrivateRematchControl matchId={matchId} supabase={supabase} />
          )}
          <button type="button" onClick={onExit}>
            Return to menu
          </button>
        </section>
      </main>
    );
  }

  const finishedPlayers = room.players.filter(
    (player) => player.finished_at,
  ).length;

  return (
    <main className={styles.appShell}>
      <AppHeader
        activeMatch={shouldWarnBeforeLeaving}
        onActiveNavigate={leaveActivePrivateMatch}
      />
      <section className={styles.statusCard}>
        <div className={styles.roomMeta}>
          <span>{isOnline ? connectionLabel : "Offline"}</span>
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
            <p className={styles.kicker}>Private lobby</p>
            <h1>{isHost ? "Bring your crew." : "Waiting for the host."}</h1>
            <p className={styles.statusLead}>
              {ruleset.rows}×{ruleset.columns} {ruleset.shape} ·{" "}
              {ruleset.roundDurationSeconds} seconds · {room.players.length}/
              {room.match.max_players} players
            </p>
            <output
              className={styles.roomCode}
              aria-label="Room code"
              data-copyable="true"
            >
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
            <a
              className={styles.inviteLink}
              data-copyable="true"
              href={inviteUrl}
            >
              {inviteUrl}
            </a>
            <div className={styles.players}>
              {room.players.map((player) => (
                <span key={player.player_user_id}>
                  <i aria-hidden="true" />
                  {player.displayName}
                  {player.player_user_id === room.match.host_user_id
                    ? " · host"
                    : ""}
                </span>
              ))}
              {room.players.length < room.match.max_players ? (
                <span className={styles.searching}>
                  <i aria-hidden="true" />
                  Waiting for more players...
                </span>
              ) : null}
            </div>
            {isHost && room.players.length < 2 ? (
              <p className={styles.statusLead}>
                At least one friend must join before you can start.
              </p>
            ) : null}
          </>
        ) : view === "countdown" ? (
          <>
            <p className={styles.kicker}>Lobby locked</p>
            <h1>Get ready.</h1>
            <div className={styles.countdown} role="timer">
              {countdownSeconds}
            </div>
            <PregamePreview
              board={board}
              boardRevision={room.match.board_revision}
              columns={ruleset.columns}
              matchId={matchId}
              participantCount={room.players.length}
              seconds={countdownSeconds}
              supabase={supabase}
              onChanged={fetchRoom}
            />
            <p className={styles.statusLead}>
              All {room.players.length} players begin at the same
              database-scheduled time.
            </p>
          </>
        ) : (
          <>
            <p className={styles.kicker}>
              {isSubmitting ? "Validating your result" : "Result submitted"}
            </p>
            <h1>
              {isSubmitting ? "Checking paths..." : "Waiting on the lobby."}
            </h1>
            <p className={styles.statusLead}>
              {finishedPlayers} of {room.players.length} validated results are
              in.
            </p>
          </>
        )}

        {!isOnline ? (
          <div className={styles.error} role="status">
            <p>
              Multiplayer needs an internet connection. Your local draft is
              safe; reconnect to resume and submit.
            </p>
          </div>
        ) : null}
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

        {canStart ? (
          <button
            className={styles.startButton}
            type="button"
            onClick={() => runRoomAction("start")}
          >
            Start countdown
          </button>
        ) : null}
        {canCancel ? (
          <button
            className={styles.cancelButton}
            type="button"
            onClick={() => runRoomAction("cancel")}
          >
            Cancel lobby
          </button>
        ) : null}
        {canLeave ? (
          <button
            className={styles.cancelButton}
            type="button"
            onClick={() => runRoomAction("leave")}
          >
            Leave lobby
          </button>
        ) : null}
      </section>
    </main>
  );
}
