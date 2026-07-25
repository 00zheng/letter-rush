"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePlayerChallenges } from "@/hooks/use-player-challenges";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";

import styles from "./game-app.module.css";

type PlayerChallengeInboxProps = {
  supabase: BrowserSupabaseClient;
  onOpenPrivateMatch: (match: { matchId: string; roomCode: string }) => void;
};

export function PlayerChallengeInbox({
  supabase,
  onOpenPrivateMatch,
}: PlayerChallengeInboxProps) {
  const router = useRouter();
  const { challenges, error, refresh } = usePlayerChallenges(supabase);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const acceptedChallenge = challenges.find(
    (challenge) =>
      challenge.challenge_status === "accepted" && challenge.match_id,
  );
  const incomingChallenge = challenges.find(
    (challenge) =>
      challenge.direction === "incoming" &&
      challenge.challenge_status === "pending",
  );
  const outgoingChallenge = challenges.find(
    (challenge) =>
      challenge.direction === "outgoing" &&
      challenge.challenge_status === "pending",
  );

  useEffect(() => {
    if (!acceptedChallenge?.match_id || !acceptedChallenge.match_mode) return;

    if (acceptedChallenge.match_mode === "ranked") {
      router.push(`/ranked/${acceptedChallenge.match_id}`);
      return;
    }

    onOpenPrivateMatch({
      matchId: acceptedChallenge.match_id,
      roomCode: acceptedChallenge.room_code ?? "",
    });
  }, [acceptedChallenge, onOpenPrivateMatch, router]);

  async function respond(accept: boolean) {
    if (!incomingChallenge) return;
    setIsWorking(true);
    setActionError(null);
    const { data, error: responseError } = await supabase.rpc(
      "respond_player_challenge",
      {
        p_challenge_id: incomingChallenge.challenge_id,
        p_accept: accept,
      },
    );
    setIsWorking(false);

    const response = data?.[0];
    if (responseError || !response) {
      setActionError(
        "That challenge could not be answered. It may have expired.",
      );
      return;
    }
    if (response.challenge_status === "accepted" && response.match_id) {
      if (response.match_mode === "ranked") {
        router.push(`/ranked/${response.match_id}`);
      } else {
        onOpenPrivateMatch({
          matchId: response.match_id,
          roomCode: response.room_code ?? "",
        });
      }
      return;
    }
    await refresh();
  }

  async function cancelOutgoing() {
    if (!outgoingChallenge) return;
    setIsWorking(true);
    setActionError(null);
    const { data, error: cancelError } = await supabase.rpc(
      "cancel_player_challenge",
      { p_challenge_id: outgoingChallenge.challenge_id },
    );
    setIsWorking(false);
    if (cancelError || !data) {
      setActionError("That challenge could not be cancelled.");
      return;
    }
    await refresh();
  }

  if (!incomingChallenge && !outgoingChallenge && !error && !actionError) {
    return null;
  }

  const activeChallenge = incomingChallenge ?? outgoingChallenge;
  return (
    <aside className={styles.rematchInvite} aria-live="polite">
      {activeChallenge ? (
        <div>
          <strong>
            {incomingChallenge ? "Player challenge" : "Challenge sent"}
          </strong>
          <span>
            <Link
              href={`/players/${activeChallenge.opponent_public_profile_id}`}
            >
              {activeChallenge.opponent_display_name}
            </Link>
            {" · "}
            {activeChallenge.rated ? "Elo rated" : "Casual"}
          </span>
        </div>
      ) : null}
      {incomingChallenge ? (
        <div>
          <button
            disabled={isWorking}
            onClick={() => void respond(true)}
            type="button"
          >
            Accept
          </button>
          <button
            disabled={isWorking}
            onClick={() => void respond(false)}
            type="button"
          >
            Decline
          </button>
        </div>
      ) : outgoingChallenge ? (
        <button
          disabled={isWorking}
          onClick={() => void cancelOutgoing()}
          type="button"
        >
          Cancel
        </button>
      ) : null}
      {(actionError ?? error) ? (
        <small role="alert">{actionError ?? error}</small>
      ) : null}
    </aside>
  );
}
