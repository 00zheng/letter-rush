"use client";

import { type FormEvent, useEffect, useState } from "react";

import { useAnonymousAuth } from "@/hooks/use-anonymous-auth";
import { normalizeRoomCode, validateRoomCode } from "@/multiplayer/room-code";

import { AppHeader } from "./app-header";
import { LetterRushGame } from "./letter-rush-game";
import { PrivateMatchRoom } from "./private-match-room";
import styles from "./game-app.module.css";

const ACTIVE_MATCH_KEY = "letter-rush:active-match";

type AppScreen = "menu" | "single" | "room";

type ActiveRoom = {
  matchId: string;
  roomCode: string;
};

function roomErrorMessage(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("full")) return "That private room is full.";
  if (normalized.includes("started")) {
    return "That match has already started.";
  }
  if (normalized.includes("missing") || normalized.includes("not found")) {
    return "That room code was not found or has expired.";
  }
  if (normalized.includes("cancel")) return "That room was cancelled.";
  if (normalized.includes("completed")) return "That match is already over.";
  if (normalized.includes("host")) {
    return "The room host cannot join the second player slot.";
  }

  return message;
}

export function GameApp() {
  const {
    state: auth,
    supabase,
    retry,
    updateDisplayName,
  } = useAnonymousAuth();
  const [screen, setScreen] = useState<AppScreen>("menu");
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const url = new URL(window.location.href);
      const inviteCode = normalizeRoomCode(url.searchParams.get("room") ?? "");
      const explicitMatchId = url.searchParams.get("match");
      const storedMatchId = window.localStorage.getItem(ACTIVE_MATCH_KEY);

      if (inviteCode) setRoomCode(inviteCode);

      const restorableMatchId = explicitMatchId ?? storedMatchId;

      if (restorableMatchId) {
        setActiveRoom({
          matchId: restorableMatchId,
          roomCode: inviteCode,
        });
        setScreen("room");
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  function enterRoom(room: ActiveRoom) {
    window.localStorage.setItem(ACTIVE_MATCH_KEY, room.matchId);
    const url = new URL(window.location.href);
    url.searchParams.set("match", room.matchId);
    url.searchParams.set("room", room.roomCode);
    window.history.replaceState(null, "", url);
    setActiveRoom(room);
    setScreen("room");
  }

  function returnToMenu() {
    window.localStorage.removeItem(ACTIVE_MATCH_KEY);
    const url = new URL(window.location.href);
    url.searchParams.delete("match");
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url.pathname);
    setActiveRoom(null);
    setMessage(null);
    setScreen("menu");
  }

  async function createPrivateMatch() {
    if (!supabase || auth.status !== "ready") return;

    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("create_private_match");
    setIsWorking(false);

    if (error || !data?.[0]) {
      setMessage(
        roomErrorMessage(
          error?.message ?? "The private room could not be created.",
        ),
      );
      return;
    }

    enterRoom({
      matchId: data[0].match_id,
      roomCode: data[0].room_code,
    });
  }

  async function joinPrivateMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || auth.status !== "ready") return;

    const validation = validateRoomCode(roomCode);

    if (!validation.isValid) {
      setMessage(validation.message);
      return;
    }

    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("join_private_match", {
      p_room_code: validation.code,
    });
    setIsWorking(false);

    if (error || !data?.[0]) {
      setMessage(
        roomErrorMessage(
          error?.message ?? "The private room could not be joined.",
        ),
      );
      return;
    }

    enterRoom({
      matchId: data[0].match_id,
      roomCode: data[0].room_code,
    });
  }

  async function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await updateDisplayName(displayNameDraft);
    if (saved) setIsEditingName(false);
  }

  if (screen === "single") {
    return <LetterRushGame onExit={returnToMenu} />;
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
        <p>Private rooms have landed</p>
        <h1>Choose your rush.</h1>
        <p className={styles.lead}>
          Play the original local sprint, or invite one friend to the same
          seeded board and synchronized clock.
        </p>
      </section>

      <section className={styles.menuGrid} aria-label="Game modes">
        <article className={`${styles.modeCard} ${styles.singleCard}`}>
          <span className={styles.cardNumber}>01</span>
          <p>Always available</p>
          <h2>Single Player</h2>
          <p>
            The original 60-second game. No account or network connection
            required.
          </p>
          <button type="button" onClick={() => setScreen("single")}>
            Play solo <span aria-hidden="true">↗</span>
          </button>
        </article>

        <article className={`${styles.modeCard} ${styles.privateCard}`}>
          <span className={styles.cardNumber}>02</span>
          <p>Two players · invite only</p>
          <h2>Private Match</h2>

          {auth.status === "ready" ? (
            <>
              <div className={styles.guestRow}>
                <div>
                  <small>Playing as</small>
                  <strong>{auth.displayName}</strong>
                </div>
                <button
                  className={styles.linkButton}
                  type="button"
                  onClick={() => {
                    if (!isEditingName) {
                      setDisplayNameDraft(auth.displayName);
                    }
                    setIsEditingName((editing) => !editing);
                  }}
                >
                  {isEditingName ? "Close" : "Edit name"}
                </button>
              </div>

              {isEditingName ? (
                <form className={styles.nameForm} onSubmit={saveDisplayName}>
                  <label htmlFor="display-name">Guest display name</label>
                  <div>
                    <input
                      id="display-name"
                      maxLength={24}
                      onChange={(event) =>
                        setDisplayNameDraft(event.target.value)
                      }
                      value={displayNameDraft}
                    />
                    <button disabled={auth.isSavingName} type="submit">
                      {auth.isSavingName ? "Saving…" : "Save"}
                    </button>
                  </div>
                </form>
              ) : null}

              <button
                className={styles.createButton}
                disabled={isWorking}
                onClick={createPrivateMatch}
                type="button"
              >
                {isWorking ? "Creating…" : "Create Private Match"}
              </button>

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
                <button disabled={isWorking} type="submit">
                  Join Private Match
                </button>
              </form>
            </>
          ) : (
            <div className={styles.authState} role="status">
              <strong>
                {auth.status === "loading"
                  ? "Preparing guest access"
                  : "Private matches unavailable"}
              </strong>
              <p>{auth.message}</p>
              {auth.status === "error" ? (
                <button type="button" onClick={retry}>
                  Try again
                </button>
              ) : null}
            </div>
          )}

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
        Private room activity is visible only to its two participants. Public
        matchmaking is intentionally not included.
      </p>
    </main>
  );
}
