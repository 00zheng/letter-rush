"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  type PlayerChallenge,
  usePlayerChallenges,
} from "@/hooks/use-player-challenges";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";
import {
  reportSupabaseError,
  supabaseErrorMessage,
} from "@/lib/supabase/errors";

import styles from "./game-app.module.css";

type PlayerChallengeInboxProps = {
  supabase: BrowserSupabaseClient;
  onOpenPrivateMatch: (match: { matchId: string; roomCode: string }) => void;
};

export function selectVisiblePlayerChallenges(
  challenges: readonly PlayerChallenge[],
) {
  return {
    acceptedChallenge: challenges.find(
      (challenge) =>
        challenge.challenge_status === "accepted" && challenge.match_id,
    ),
    incomingChallenge: challenges.find(
      (challenge) =>
        challenge.direction === "incoming" &&
        challenge.challenge_status === "pending",
    ),
    outgoingChallenge: challenges.find(
      (challenge) =>
        challenge.direction === "outgoing" &&
        challenge.challenge_status === "pending",
    ),
  };
}

function friendlyChallengeResponseError(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  if (message?.includes("expired")) return "Challenge expired.";
  if (message?.includes("declined")) return "Challenge was declined.";
  if (message?.includes("active match"))
    return message.replace(/\.$/u, "") + ".";
  if (message?.includes("ranked matchmaking"))
    return message.replace(/\.$/u, "") + ".";
  return supabaseErrorMessage(error, {
    feature: "Challenges",
    productionMessage: "That challenge could not be updated. Please retry.",
    rpcName: "respond_player_challenge",
  });
}

export function PlayerChallengeInbox({
  supabase,
  onOpenPrivateMatch,
}: PlayerChallengeInboxProps) {
  const router = useRouter();
  const { challenges, error, isLoading, refresh } =
    usePlayerChallenges(supabase);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { acceptedChallenge, incomingChallenge, outgoingChallenge } =
    selectVisiblePlayerChallenges(challenges);

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
      if (responseError) {
        reportSupabaseError(responseError, {
          feature: "player challenges",
          rpcName: "respond_player_challenge",
        });
      }
      setActionError(friendlyChallengeResponseError(responseError));
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
      if (cancelError) {
        reportSupabaseError(cancelError, {
          feature: "player challenges",
          rpcName: "cancel_player_challenge",
        });
      }
      setActionError(
        supabaseErrorMessage(cancelError, {
          feature: "Challenges",
          productionMessage: "That challenge could not be cancelled.",
          rpcName: "cancel_player_challenge",
        }),
      );
      return;
    }
    await refresh();
  }

  if (!incomingChallenge && !outgoingChallenge && !error && !actionError) {
    return null;
  }

  const activeChallenge = incomingChallenge ?? outgoingChallenge;
  if (!activeChallenge) {
    return (
      <aside className={styles.serviceNotice} aria-live="polite">
        <small role="alert">{actionError ?? error}</small>
        {error ? (
          <button
            disabled={isLoading}
            onClick={() => void refresh()}
            type="button"
          >
            {isLoading ? "Retrying…" : "Retry"}
          </button>
        ) : null}
      </aside>
    );
  }

  return (
    <aside className={styles.rematchInvite} aria-live="polite">
      <div>
        <strong>
          {incomingChallenge ? "Player challenge" : "Challenge sent"}
        </strong>
        <span>
          <Link href={`/players/${activeChallenge.opponent_public_profile_id}`}>
            {activeChallenge.opponent_display_name}
          </Link>
          {" · "}
          {activeChallenge.rated ? "Elo rated" : "Casual"}
        </span>
      </div>
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
        <div>
          <small role="alert">{actionError ?? error}</small>
          {error ? (
            <button
              disabled={isLoading}
              onClick={() => void refresh()}
              type="button"
            >
              {isLoading ? "Retrying…" : "Retry"}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
