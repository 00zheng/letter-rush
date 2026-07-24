"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateBoard } from "@/game/board";
import { preloadDictionaryBuckets } from "@/game/dictionary";
import {
  calculateWordScore,
  createWordFromPath,
  validateTilePath,
} from "@/game/logic";
import { validateRuleset, type GameRuleset } from "@/game/ruleset";
import type { ScoredWordSubmission, WordPathSubmission } from "@/game/types";
import { usePlayerAuth } from "@/hooks/use-player-auth";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import {
  calculateServerClockOffset,
  deriveMultiplayerView,
  getMatchEndTimeMs,
} from "@/multiplayer/state";
import type {
  MatchPlayerRecord,
  MatchRecord,
  RoomParticipant,
} from "@/multiplayer/types";
import { parseResultRequest } from "@/multiplayer/validation";
import { isRankedRuleset } from "@/ranked/ruleset";
import type { RankedMatchResult } from "@/ranked/types";

import { AppHeader } from "./app-header";
import { LetterRushGame } from "./letter-rush-game";
import { PregamePreview } from "./pregame-preview";
import { RankedRematchControls } from "./rematch-controls";
import styles from "./ranked.module.css";

const DRAFT_PREFIX = "letter-rush:ranked-draft:";
const STALE_RESULT_WAIT_MS = 45_000;

type RankedRoomState = {
  match: MatchRecord;
  players: RoomParticipant[];
};

function draftKey(matchId: string, userId: string) {
  return `${DRAFT_PREFIX}${matchId}:${userId}`;
}

function parseValidatedWords(value: MatchPlayerRecord["validated_words"]) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      "word" in entry &&
      typeof entry.word === "string"
        ? [
            {
              word: entry.word,
              score:
                "score" in entry && typeof entry.score === "number"
                  ? entry.score
                  : calculateWordScore(entry.word),
            },
          ]
        : [],
    )
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

    return parsed.submissions.map((submission) => {
      const pathValidation = validateTilePath(submission.path, ruleset);
      const word = createWordFromPath(board, submission.path);
      if (
        !pathValidation.isValid ||
        word !== submission.word.trim().toUpperCase()
      ) {
        throw new Error("Invalid draft");
      }
      return { word, path: submission.path, score: calculateWordScore(word) };
    });
  } catch {
    return [];
  }
}

function resultHeadline(status: RankedMatchResult["result_status"]) {
  if (status === "winner") return "Victory.";
  if (status === "tie") return "Dead heat.";
  if (status === "forfeit") return "Match forfeited.";
  return "Defeat.";
}

function RankedMatchContent({
  currentUserId,
  currentPublicProfileId,
  matchId,
  supabase,
}: {
  currentUserId: string;
  currentPublicProfileId: string;
  matchId: string;
  supabase: BrowserSupabaseClient;
}) {
  const router = useRouter();
  const [room, setRoom] = useState<RankedRoomState | null>(null);
  const [results, setResults] = useState<RankedMatchResult[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [connectionLabel, setConnectionLabel] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        "This ranked match is unavailable or does not belong to this account.",
      );
    }
    if (matchData.mode !== "ranked") {
      throw new Error("This route only accepts ranked matches.");
    }

    const players = (playerData ?? []) as MatchPlayerRecord[];
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id, display_name, public_profile_id")
      .in(
        "id",
        players.map((player) => player.player_user_id),
      );
    if (profileError) {
      throw new Error("The ranked player names could not be loaded.");
    }

    const profileById = new Map(
      (profiles ?? []).map((profile) => [profile.id, profile]),
    );
    const participants: RoomParticipant[] = players.map((player) => ({
      ...player,
      displayName:
        profileById.get(player.player_user_id)?.display_name ??
        `Player ${player.player_number}`,
    }));
    const receivedAt = Date.now();
    setClockTick(receivedAt);
    setClockOffsetMs(calculateServerClockOffset(serverNow, receivedAt));
    setRoom({ match: matchData as MatchRecord, players: participants });

    if (matchData.status === "completed" || matchData.status === "cancelled") {
      const { data: resultData, error: resultError } = await supabase.rpc(
        "get_ranked_match_result",
        { p_match_id: matchId },
      );
      if (resultError) {
        throw new Error("The finalized ranked result could not be loaded.");
      }
      setResults(resultData ?? []);
    }
    setError(null);
    setIsLoading(false);
  }, [matchId, supabase]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await fetchRoom();
      } catch (loadError) {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The ranked match could not be restored.",
        );
        setIsLoading(false);
      }
    };
    void load();
    const pollId = window.setInterval(() => void load(), 4_000);
    const channel = supabase
      .channel(`ranked-match:${matchId}`)
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
        if (active) {
          setConnectionLabel(
            status === "SUBSCRIBED" ? "Live" : "Reconnecting…",
          );
        }
      });

    return () => {
      active = false;
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [fetchRoom, matchId, supabase]);

  useEffect(() => {
    const updateOnline = () => setIsOnline(navigator.onLine);
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
  const ruleset =
    rulesetValidation.isValid && isRankedRuleset(rulesetValidation.ruleset)
      ? rulesetValidation.ruleset
      : null;
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

  useEffect(() => {
    if (!board || view !== "countdown") return;
    void preloadDictionaryBuckets(board.flat()).catch(() => {
      // A later word lookup will retry the failed lazy bucket.
    });
  }, [board, view]);

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
      (roundSubmissions.length ? roundSubmissions : initialDraft).map(
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
        setNotice(body.message ?? "Ranked result validated.");
        await fetchRoom();
      } catch (submitError) {
        submissionInFlightRef.current = false;
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Your ranked result could not be submitted.",
        );
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
        setError("The recovery result could not be finalized. Retry shortly.");
        return;
      }
      await fetchRoom();
    })();
  }, [authoritativeNowMs, fetchRoom, isOnline, matchId, room, supabase, view]);

  const shouldWarnBeforeLeaving =
    view === "playing" ||
    view === "submitting" ||
    view === "waiting-for-opponent";

  useEffect(() => {
    if (!shouldWarnBeforeLeaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shouldWarnBeforeLeaving]);

  function leaveRankedMatch() {
    if (
      shouldWarnBeforeLeaving &&
      !window.confirm(
        "Leave this active ranked match? Your result still must be submitted before the recovery window ends.",
      )
    ) {
      return false;
    }
    router.push("/");
    return true;
  }

  function saveDraft(submissions: readonly ScoredWordSubmission[]) {
    setRoundSubmissions([...submissions]);
    window.localStorage.setItem(
      draftKey(matchId, currentUserId),
      JSON.stringify(submissions.map(({ word, path }) => ({ word, path }))),
    );
  }

  if (isLoading) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard} role="status">
          <p className={styles.kicker}>Ranked Quick Match</p>
          <h1>Restoring the match.</h1>
          <p>Checking the authoritative board and clock.</p>
        </section>
      </main>
    );
  }

  if (!room || !currentPlayer || !ruleset || !board) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>Ranked match unavailable</p>
          <h1>Could not restore this round.</h1>
          <p role="alert">
            {error ?? "You are not a participant, or the rules are invalid."}
          </p>
          <Link href="/">Return to menu</Link>
        </section>
      </main>
    );
  }

  if (view === "playing" && room.match.scheduled_start_at) {
    return (
      <LetterRushGame
        board={board}
        connectionStatus={
          isOnline ? connectionLabel : "Offline — ranked draft saved"
        }
        initialSubmissions={initialDraft}
        mode="multiplayer"
        onExit={leaveRankedMatch}
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
  const ownResult = results.find(
    (result) => result.public_profile_id === currentPublicProfileId,
  );
  const opponent = room.players.find(
    (player) => player.player_user_id !== currentUserId,
  );

  if (room.match.status === "completed" && ownResult) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.resultsCard}>
          <p className={styles.kicker}>Ranked result</p>
          <h1>{resultHeadline(ownResult.result_status)}</h1>
          <p className={styles.ratingChange}>
            {ownResult.rating_before}{" "}
            <span>
              {ownResult.rating_delta && ownResult.rating_delta > 0 ? "+" : ""}
              {ownResult.rating_delta ?? 0}
            </span>{" "}
            → <strong>{ownResult.rating_after}</strong>
          </p>
          <div className={styles.resultGrid}>
            {results.map((result) => (
              <article
                className={
                  result.public_profile_id === currentPublicProfileId
                    ? styles.currentResult
                    : ""
                }
                key={result.public_profile_id}
              >
                <span>{result.result_status}</span>
                <h2>
                  <Link href={`/players/${result.public_profile_id}`}>
                    {result.display_name}
                  </Link>
                  {result.public_profile_id === currentPublicProfileId
                    ? " (you)"
                    : ""}
                </h2>
                <strong>
                  {(result.validated_score ?? 0).toLocaleString("en-US")}
                </strong>
                <small>
                  Rating {result.rating_after ?? "—"} (
                  {result.rating_delta && result.rating_delta > 0 ? "+" : ""}
                  {result.rating_delta ?? 0})
                </small>
                <div className={styles.wordChips}>
                  {parseValidatedWords(result.validated_words).map(
                    ({ word, score }) => (
                      <i key={word}>
                        {word} · {score.toLocaleString("en-US")}
                      </i>
                    ),
                  )}
                  {!parseValidatedWords(result.validated_words).length ? (
                    <i>No accepted words</i>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          <RankedRematchControls matchId={matchId} supabase={supabase} />
          <div className={styles.actions}>
            <Link href="/quick-match">Play another</Link>
            <Link href="/leaderboards">Leaderboards</Link>
            <Link href="/">Return to menu</Link>
          </div>
        </section>
      </main>
    );
  }

  if (
    room.match.status === "cancelled" &&
    room.match.rating_status === "abandoned"
  ) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>Ranked match abandoned</p>
          <h1>No result, no rating change.</h1>
          <p>Neither player submitted during the round or recovery window.</p>
          <div className={styles.actions}>
            <Link href="/quick-match">Search again</Link>
            <Link href="/">Return to menu</Link>
          </div>
        </section>
      </main>
    );
  }

  const finishedPlayers = room.players.filter(
    (player) => player.finished_at,
  ).length;

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.statusCard}>
        <div className={styles.livePill} role="status">
          <i aria-hidden="true" />
          {isOnline ? connectionLabel : "Offline — reconnect to submit"}
        </div>
        {view === "countdown" ? (
          <>
            <p className={styles.kicker} role="status">
              Opponent connected
            </p>
            <h1>Same board. Same clock.</h1>
            <div className={styles.countdown} role="timer">
              {countdownSeconds}
            </div>
            <PregamePreview
              board={board}
              columns={ruleset.columns}
              matchId={matchId}
              participantCount={2}
              rerollUsed={room.match.reroll_used}
              seconds={countdownSeconds}
              supabase={supabase}
              onChanged={fetchRoom}
            />
            <p className={styles.supporting}>
              You vs. {opponent?.displayName ?? "your opponent"} · fixed 4×4
              board · 60 seconds · classic scoring · Elo rated
            </p>
          </>
        ) : (
          <>
            <p className={styles.kicker}>
              {isSubmitting
                ? "Authoritative validation"
                : finishedPlayers === 2
                  ? "Rating finalization"
                  : "Round complete"}
            </p>
            <h1>
              {isSubmitting
                ? "Checking every path."
                : finishedPlayers === 2
                  ? "Locking the result."
                  : "Waiting for your rival."}
            </h1>
            <p className={styles.supporting}>
              {finishedPlayers} of 2 results received. A missing player forfeits
              after the 45-second recovery window.
            </p>
          </>
        )}
        {notice ? <p className={styles.notice}>{notice}</p> : null}
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
      </section>
    </main>
  );
}

export function RankedMatchRoom({ matchId }: { matchId: string }) {
  const { state: auth, supabase, retry } = usePlayerAuth();

  if (auth.status !== "ready" || !supabase) {
    return (
      <main className={styles.appShell}>
        <AppHeader />
        <section className={styles.statusCard}>
          <p className={styles.kicker}>Ranked Quick Match</p>
          <h1>
            {auth.status === "loading"
              ? "Restoring your account."
              : "Ranked play is unavailable."}
          </h1>
          <p role={auth.status === "error" ? "alert" : undefined}>
            {auth.message}
          </p>
          <div className={styles.actions}>
            {auth.status === "error" ? (
              <button type="button" onClick={retry}>
                Retry
              </button>
            ) : null}
            <Link href="/">Return to menu</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <RankedMatchContent
      currentPublicProfileId={auth.publicProfileId}
      currentUserId={auth.user.id}
      matchId={matchId}
      supabase={supabase}
    />
  );
}
