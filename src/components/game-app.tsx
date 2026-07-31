"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { generateBoard } from "@/game/board";
import { DEFAULT_RULESET, validateRuleset } from "@/game/ruleset";
import type { WordPathSubmission } from "@/game/types";
import { usePlayerAuth } from "@/hooks/use-player-auth";
import { BoundedRequestGate } from "@/lib/bounded-request";
import type { Json } from "@/lib/supabase/database.types";
import {
  classifySupabaseError,
  privateLobbyErrorMessage,
  reportSupabaseError,
} from "@/lib/supabase/errors";
import { normalizeRoomCode, validateRoomCode } from "@/multiplayer/room-code";

import { AppHeader } from "./app-header";
import { LetterRushGame } from "./letter-rush-game";
import {
  LobbyConfigurator,
  type LobbyConfiguration,
} from "./lobby-configurator";
import { PlayerChallengeInbox } from "./player-challenge-inbox";
import { PrivateMatchRoom } from "./private-match-room";
import styles from "./game-app.module.css";

const ACTIVE_MATCH_KEY = "letter-rush:active-match";
const ACTIVE_SOLO_KEY = "letter-rush:active-solo";

type AppScreen = "menu" | "single" | "room";
type ActiveRoom = { matchId: string; roomCode: string };
type SoloSession = {
  matchId: string;
  boardSeed: number;
  scheduledStartAt: string;
  roundDurationSeconds: number;
  ruleset: typeof DEFAULT_RULESET;
  serverClockOffsetMs: number;
};
type PendingPrivateRematch = {
  match_id: string;
  room_code: string;
  source_match_id: string;
  expires_at: string;
  created_at: string;
};
type SoloResultStatus = "idle" | "saving" | "saved" | "error";

function roomErrorMessage(error: unknown): string {
  const normalized =
    error && typeof error === "object" && "message" in error
      ? String(error.message).toLowerCase()
      : String(error).toLowerCase();
  if (normalized.includes("full")) return "That private lobby is full.";
  if (normalized.includes("already in")) {
    return "This account is already in that lobby.";
  }
  if (normalized.includes("started")) return "That match has already started.";
  if (normalized.includes("missing") || normalized.includes("not found")) {
    return "That room code was not found or has expired.";
  }
  if (classifySupabaseError(error).kind === "lobby_cancelled") {
    return "That lobby was cancelled.";
  }
  if (normalized.includes("completed")) return "That match is already over.";
  return "The lobby request could not be completed. Please try again.";
}

export function GameApp() {
  const { state: auth, supabase, retry } = usePlayerAuth();
  const [screen, setScreen] = useState<AppScreen>("menu");
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [soloSession, setSoloSession] = useState<SoloSession | null>(null);
  const [soloResultStatus, setSoloResultStatus] =
    useState<SoloResultStatus>("idle");
  const [soloMessage, setSoloMessage] = useState<string | null>(null);
  const [soloLifecycleMessage, setSoloLifecycleMessage] = useState<
    string | null
  >(null);
  const [pendingSoloSubmissions, setPendingSoloSubmissions] = useState<
    readonly WordPathSubmission[]
  >([]);
  const [roomCode, setRoomCode] = useState("");
  const [directRoomCode, setDirectRoomCode] = useState<string | null>(null);
  const [isAutoJoining, setIsAutoJoining] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingRematch, setPendingRematch] =
    useState<PendingPrivateRematch | null>(null);
  const [lobbyConfiguration, setLobbyConfiguration] =
    useState<LobbyConfiguration>({
      ruleset: DEFAULT_RULESET,
      maxPlayers: 2,
    });
  const soloRestoreAttemptedRef = useRef(false);
  const soloStartInFlightRef = useRef(false);
  const joinInFlightRef = useRef(false);
  const autoJoinAttemptedRef = useRef<string | null>(null);
  const [privateLobbyRequestGate] = useState(() => new BoundedRequestGate());

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const url = new URL(window.location.href);
      const inviteCode = normalizeRoomCode(url.searchParams.get("room") ?? "");
      const explicitMatchId = url.searchParams.get("match");
      const storedMatchId = window.localStorage.getItem(ACTIVE_MATCH_KEY);

      if (inviteCode) {
        setRoomCode(inviteCode);
        setDirectRoomCode(inviteCode);
      }
      const restorableMatchId =
        explicitMatchId ?? (inviteCode ? null : storedMatchId);
      if (restorableMatchId) {
        setActiveRoom({ matchId: restorableMatchId, roomCode: inviteCode });
        setScreen("room");
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(
    () => () => {
      privateLobbyRequestGate.cancel();
    },
    [privateLobbyRequestGate],
  );

  useEffect(() => {
    if (!supabase || auth.status !== "ready") return;
    let active = true;
    const load = async () => {
      const { data } = await supabase.rpc("get_pending_private_rematches");
      if (active) setPendingRematch(data?.[0] ?? null);
    };
    void load();
    const pollId = window.setInterval(() => void load(), 5_000);
    const channel = supabase
      .channel(`private-rematch-invites:${auth.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "private_rematch_invitations",
          filter: `invited_user_id=eq.${auth.user.id}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      active = false;
      window.clearInterval(pollId);
      void supabase.removeChannel(channel);
    };
  }, [auth, supabase]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    updateOnlineState();
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  const updateLobbyConfiguration = useCallback(
    (configuration: LobbyConfiguration | null) => {
      setLobbyConfiguration(
        configuration ?? { ruleset: DEFAULT_RULESET, maxPlayers: 0 },
      );
    },
    [],
  );

  const enterRoom = useCallback((room: ActiveRoom) => {
    window.localStorage.setItem(ACTIVE_MATCH_KEY, room.matchId);
    const url = new URL(window.location.href);
    url.searchParams.set("match", room.matchId);
    url.searchParams.set("room", room.roomCode);
    window.history.replaceState(null, "", url);
    setActiveRoom(room);
    setScreen("room");
  }, []);

  const joinRoomByCode = useCallback(
    async (code: string, automatic = false) => {
      if (
        !supabase ||
        auth.status !== "ready" ||
        !isOnline ||
        joinInFlightRef.current
      ) {
        return;
      }

      const validation = validateRoomCode(code);
      if (!validation.isValid) {
        setMessage(validation.message);
        return;
      }

      joinInFlightRef.current = true;
      setIsWorking(true);
      setIsAutoJoining(automatic);
      setMessage(null);
      try {
        const { data, error } = await supabase.rpc("join_private_match", {
          p_room_code: validation.code,
        });
        const joined = data?.[0];
        if (error || !joined) {
          setMessage(
            roomErrorMessage(error ?? "The lobby could not be joined."),
          );
          return;
        }

        setDirectRoomCode(null);
        enterRoom({
          matchId: joined.match_id,
          roomCode: joined.room_code,
        });
      } catch (error) {
        setMessage(roomErrorMessage(error));
      } finally {
        joinInFlightRef.current = false;
        setIsWorking(false);
        setIsAutoJoining(false);
      }
    },
    [auth.status, enterRoom, isOnline, supabase],
  );

  useEffect(() => {
    if (
      !directRoomCode ||
      auth.status !== "ready" ||
      !supabase ||
      !isOnline ||
      screen !== "menu"
    ) {
      return;
    }
    const attemptKey = `${auth.user.id}:${directRoomCode}`;
    if (autoJoinAttemptedRef.current === attemptKey) return;
    autoJoinAttemptedRef.current = attemptKey;
    const timeoutId = window.setTimeout(() => {
      void joinRoomByCode(directRoomCode, true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [auth, directRoomCode, isOnline, joinRoomByCode, screen, supabase]);

  function returnToMenu() {
    window.localStorage.removeItem(ACTIVE_MATCH_KEY);
    window.localStorage.removeItem(ACTIVE_SOLO_KEY);
    const url = new URL(window.location.href);
    url.searchParams.delete("match");
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url.pathname);
    setActiveRoom(null);
    setSoloSession(null);
    setSoloLifecycleMessage(null);
    setSoloResultStatus("idle");
    setPendingSoloSubmissions([]);
    setMessage(null);
    setScreen("menu");
  }

  const createSoloSession = useCallback(async () => {
    if (
      !supabase ||
      auth.status !== "ready" ||
      !isOnline ||
      soloStartInFlightRef.current
    ) {
      return;
    }
    soloStartInFlightRef.current = true;
    setIsWorking(true);
    setSoloMessage(null);

    try {
      const { data, error } = await supabase.rpc(
        "create_or_resume_solo_session",
        {
          p_ruleset: DEFAULT_RULESET as unknown as Json,
        },
      );
      const session = data?.[0];
      const rulesetValidation = validateRuleset(session?.ruleset);
      if (error || !session || !rulesetValidation.isValid) {
        setSoloMessage("We could not contact the game server. Try again.");
        return;
      }

      const lifecycleMessage =
        session.session_action === "resumed"
          ? "Resuming your unfinished round."
          : session.session_action === "replaced"
            ? "Your previous round expired. Starting a new one."
            : null;
      window.localStorage.setItem(ACTIVE_SOLO_KEY, session.match_id);
      setSoloSession({
        matchId: session.match_id,
        boardSeed: session.board_seed,
        scheduledStartAt: session.scheduled_start_at,
        roundDurationSeconds: session.round_duration_seconds,
        ruleset: rulesetValidation.ruleset,
        serverClockOffsetMs: Date.parse(session.server_now) - Date.now(),
      });
      setSoloLifecycleMessage(lifecycleMessage);
      setSoloResultStatus("idle");
      setPendingSoloSubmissions([]);
      setScreen("single");
    } catch {
      setSoloMessage("We could not contact the game server. Try again.");
    } finally {
      soloStartInFlightRef.current = false;
      setIsWorking(false);
    }
  }, [auth.status, isOnline, supabase]);

  useEffect(() => {
    if (
      soloRestoreAttemptedRef.current ||
      auth.status !== "ready" ||
      !supabase ||
      !isOnline
    ) {
      return;
    }
    soloRestoreAttemptedRef.current = true;
    if (window.localStorage.getItem(ACTIVE_SOLO_KEY)) {
      const timeoutId = window.setTimeout(() => {
        void createSoloSession();
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [auth.status, createSoloSession, isOnline, supabase]);

  async function abandonSoloSession() {
    const session = soloSession;
    if (!supabase || !session || auth.status !== "ready") return false;

    setIsWorking(true);
    setSoloMessage(null);
    try {
      const { data, error } = await supabase.rpc("abandon_solo_session", {
        p_match_id: session.matchId,
      });
      if (error || !data?.[0]) {
        setSoloLifecycleMessage(
          error?.message.toLowerCase().includes("already completed")
            ? "This round was already completed."
            : "We could not contact the game server. Try again.",
        );
        return false;
      }

      returnToMenu();
      setSoloMessage("Round exited. Partial words and score were not saved.");
      return true;
    } catch {
      setSoloLifecycleMessage(
        "We could not contact the game server. Try again.",
      );
      return false;
    } finally {
      setIsWorking(false);
    }
  }

  async function submitSoloResult(submissions: readonly WordPathSubmission[]) {
    if (!soloSession) return;
    setSoloResultStatus("saving");
    setPendingSoloSubmissions(submissions);
    setMessage(null);
    try {
      const response = await fetch("/api/matches/results", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          matchId: soloSession.matchId,
          submissions,
        }),
      });
      if (!response.ok) {
        throw new Error("result validation failed");
      }
      window.localStorage.removeItem(ACTIVE_SOLO_KEY);
      setSoloResultStatus("saved");
    } catch {
      setSoloResultStatus("error");
      setMessage(
        "Reconnect to validate this round and update saved statistics.",
      );
    }
  }

  async function createPrivateMatch() {
    if (
      !supabase ||
      auth.status !== "ready" ||
      lobbyConfiguration.maxPlayers < 2 ||
      !isOnline ||
      privateLobbyRequestGate.isPending
    ) {
      return;
    }

    const request = privateLobbyRequestGate.start(
      async (signal) =>
        await supabase
          .rpc("create_private_lobby", {
            p_ruleset: lobbyConfiguration.ruleset as unknown as Json,
            p_max_players: lobbyConfiguration.maxPlayers,
          })
          .abortSignal(signal),
      8_000,
    );
    if (!request) return;

    const { generationId } = request;
    setIsWorking(true);
    setMessage(null);

    try {
      const { data, error } = await request.promise;
      if (!privateLobbyRequestGate.isLatest(generationId)) return;

      if (error || !data?.[0]) {
        const requestError =
          error ?? new Error("The lobby response was incomplete.");
        reportSupabaseError(requestError, {
          feature: "private lobby creation",
          requestGenerationId: generationId,
          rpcName: "create_private_lobby",
        });
        setMessage(privateLobbyErrorMessage(requestError));
        return;
      }

      enterRoom({
        matchId: data[0].match_id,
        roomCode: data[0].room_code,
      });
    } catch (error: unknown) {
      if (!privateLobbyRequestGate.isLatest(generationId)) return;
      reportSupabaseError(error, {
        feature: "private lobby creation",
        requestGenerationId: generationId,
        rpcName: "create_private_lobby",
      });
      setMessage(privateLobbyErrorMessage(error));
    } finally {
      if (privateLobbyRequestGate.isLatest(generationId)) {
        setIsWorking(false);
      }
    }
  }

  async function acceptPendingRematch() {
    if (!supabase || !pendingRematch) return;
    setIsWorking(true);
    const { data, error } = await supabase.rpc(
      "accept_private_rematch_invite",
      { p_match_id: pendingRematch.match_id },
    );
    setIsWorking(false);
    const joined = data?.[0];
    if (error || !joined) {
      setMessage("That private rematch invitation is no longer available.");
      return;
    }
    setPendingRematch(null);
    enterRoom({ matchId: joined.match_id, roomCode: joined.room_code });
  }

  async function joinPrivateMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await joinRoomByCode(roomCode);
  }

  async function startAnotherSoloRound() {
    if (
      soloResultStatus !== "saved" &&
      !window.confirm(
        "Start a new round? This unsaved round will be abandoned without points.",
      )
    ) {
      return;
    }

    if (soloResultStatus === "saved") {
      returnToMenu();
    } else if (!(await abandonSoloSession())) {
      return;
    }
    await createSoloSession();
  }

  async function returnFromSoloResults() {
    if (soloResultStatus === "saved") {
      returnToMenu();
      return;
    }
    if (
      window.confirm(
        "Return to the menu? This unsaved round will be abandoned without points.",
      )
    ) {
      await abandonSoloSession();
    }
  }

  if (screen === "single" && soloSession) {
    return (
      <LetterRushGame
        analysisMatchId={soloSession.matchId}
        analysisSupabase={supabase}
        board={generateBoard(soloSession.boardSeed, soloSession.ruleset)}
        connectionStatus={soloLifecycleMessage ?? undefined}
        key={soloSession.matchId}
        mode="solo"
        onExit={abandonSoloSession}
        onPlayAgain={() => void startAnotherSoloRound()}
        onReturnToMenu={() => void returnFromSoloResults()}
        onRetryResult={() => {
          void submitSoloResult(pendingSoloSubmissions);
        }}
        onRoundComplete={submitSoloResult}
        resultStatus={soloResultStatus}
        roundDurationSeconds={soloSession.roundDurationSeconds}
        ruleset={soloSession.ruleset}
        scheduledStartAt={soloSession.scheduledStartAt}
        serverClockOffsetMs={soloSession.serverClockOffsetMs}
      />
    );
  }

  if (screen === "room" && activeRoom && auth.status === "ready" && supabase) {
    return (
      <PrivateMatchRoom
        currentUserId={auth.user.id}
        initialRoomCode={activeRoom.roomCode}
        matchId={activeRoom.matchId}
        onExit={returnToMenu}
        supabase={supabase}
      />
    );
  }

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.hero}>
        <p>Three ways to play</p>
        <h1>Pick a game.</h1>
        <p className={styles.lead}>
          Play a one-minute solo round, match with a rival, or start a private
          room with friends.
        </p>
      </section>
      {pendingRematch ? (
        <aside className={styles.rematchInvite} role="status">
          <div>
            <strong>Private rematch invitation</strong>
            <span>Room {pendingRematch.room_code}</span>
          </div>
          <button
            disabled={isWorking}
            onClick={() => void acceptPendingRematch()}
            type="button"
          >
            Rejoin rematch
          </button>
        </aside>
      ) : null}
      {auth.status === "ready" && supabase ? (
        <PlayerChallengeInbox
          onOpenPrivateMatch={enterRoom}
          supabase={supabase}
        />
      ) : null}

      <section className={styles.menuGrid} aria-label="Game modes">
        <article className={`${styles.modeCard} ${styles.singleCard}`}>
          <span className={styles.cardNumber}>01</span>
          <p>Play at your pace</p>
          <h2>Solo</h2>
          <p>
            Find as many words as you can in 60 seconds. Your best scores are
            saved to your profile.
          </p>
          {auth.status === "ready" ? (
            <button
              disabled={isWorking || !isOnline}
              type="button"
              onClick={() => void createSoloSession()}
            >
              Play solo
            </button>
          ) : auth.status === "anonymous" ? (
            <Link href="/claim-account?next=%2F">Claim account to play</Link>
          ) : auth.status === "signed-out" ? (
            <Link href="/login?next=%2F">Sign in to play</Link>
          ) : (
            <button disabled type="button">
              Account required
            </button>
          )}
          {soloMessage ? (
            <p className={styles.errorMessage} role="status">
              {soloMessage}
            </p>
          ) : null}
        </article>

        <article className={`${styles.modeCard} ${styles.rankedCard}`}>
          <span className={styles.cardNumber}>02</span>
          <p>Head-to-head · rated</p>
          <h2>Quick Match</h2>
          <p>
            Play the same 4×4 board as one evenly matched opponent. Highest
            score wins.
          </p>
          {auth.status === "ready" ? (
            <>
              <div className={styles.rankedIdentity}>
                <span>Playing as {auth.displayName}</span>
                <strong>#{auth.publicProfileId}</strong>
              </div>
              <Link href="/quick-match">Find opponent</Link>
            </>
          ) : (
            <div className={styles.authState} role="status">
              <strong>
                {auth.status === "loading"
                  ? "Loading player"
                  : "Ranked play unavailable"}
              </strong>
              <p>{auth.message}</p>
              {auth.status === "anonymous" ? (
                <Link href="/claim-account?next=%2Fquick-match">
                  Claim guest account
                </Link>
              ) : auth.status === "signed-out" ? (
                <Link href="/login?next=%2Fquick-match">Sign in to play</Link>
              ) : null}
            </div>
          )}
          <div className={styles.rankLinks}>
            <Link href="/leaderboards">Leaderboards</Link>
            {auth.status === "ready" ? (
              <Link href={`/players/${auth.publicProfileId}`}>My profile</Link>
            ) : null}
          </div>
        </article>

        <article className={`${styles.modeCard} ${styles.privateCard}`}>
          <span className={styles.cardNumber}>03</span>
          <p>2–12 players · invite only</p>
          <h2>Private Lobby</h2>

          {auth.status === "ready" ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void createPrivateMatch();
                }}
              >
                <LobbyConfigurator onChange={updateLobbyConfiguration} />

                <button
                  className={styles.createButton}
                  disabled={
                    isWorking || !isOnline || lobbyConfiguration.maxPlayers < 2
                  }
                  type="submit"
                >
                  {isWorking ? "Creating..." : "Create Private Lobby"}
                </button>
              </form>

              <div className={styles.divider}>
                <span>or join with a code</span>
              </div>
              <form className={styles.joinForm} onSubmit={joinPrivateMatch}>
                <label htmlFor="room-code">Room code</label>
                <input
                  id="room-code"
                  inputMode="text"
                  maxLength={10}
                  onChange={(event) => setRoomCode(event.target.value)}
                  placeholder="ABC234"
                  value={roomCode}
                />
                <button disabled={isWorking || !isOnline} type="submit">
                  Join Private Lobby
                </button>
              </form>
              {isAutoJoining ? (
                <p className={styles.inlineMessage} role="status">
                  Joining room {roomCode}…
                </p>
              ) : null}
            </>
          ) : (
            <div className={styles.authState} role="status">
              <strong>
                {auth.status === "loading"
                  ? "Loading player"
                  : "Private lobbies unavailable"}
              </strong>
              <p>{auth.message}</p>
              {auth.status === "anonymous" ? (
                <Link
                  href={`/claim-account?next=${encodeURIComponent(
                    roomCode ? `/?room=${roomCode}` : "/",
                  )}`}
                >
                  Claim guest account
                </Link>
              ) : auth.status === "signed-out" ? (
                <Link
                  href={`/login?next=${encodeURIComponent(
                    roomCode ? `/?room=${roomCode}` : "/",
                  )}`}
                >
                  Sign in to play
                </Link>
              ) : null}
              {auth.status === "error" ? (
                <button type="button" onClick={retry}>
                  Try again
                </button>
              ) : null}
            </div>
          )}

          {!isOnline ? (
            <p className={styles.errorMessage} role="status">
              You are offline. Reconnect to start or join a validated game.
            </p>
          ) : null}
          {auth.status === "ready" && auth.message ? (
            <p className={styles.inlineMessage} role="status">
              {auth.message}
            </p>
          ) : null}
          {message ? (
            <p className={styles.errorMessage} role="alert">
              {message}
            </p>
          ) : null}
        </article>
      </section>

      <p className={styles.privacyNote}>
        Ranked profiles and rated results are public through opaque player IDs.
        Private lobby activity remains visible only to its participants.
      </p>
    </main>
  );
}
