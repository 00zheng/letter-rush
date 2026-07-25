"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePlayerChallenges } from "@/hooks/use-player-challenges";
import type { BrowserSupabaseClient } from "@/lib/supabase/client";

import styles from "./ranked.module.css";

type ProfileChallengeControlsProps = {
  publicProfileId: string;
  supabase: BrowserSupabaseClient;
};

function friendlyChallengeError(message: string | undefined): string {
  if (message?.includes("cannot challenge yourself"))
    return "You cannot challenge yourself.";
  if (message?.includes("Player profile was not found"))
    return "Player profile was not found.";
  if (message?.includes("You are already in an active match"))
    return "You are already in an active match.";
  if (message?.includes("That player is already in an active match"))
    return "That player is already in an active match.";
  if (message?.includes("already sent"))
    return "You already sent this player a challenge.";
  if (message?.includes("already challenged you"))
    return "That player already challenged you.";
  if (message?.includes("Challenge expired")) return "Challenge expired.";
  if (message?.includes("Challenge was declined"))
    return "Challenge was declined.";
  if (message?.includes("ranked matchmaking"))
    return message.replace(/\.$/u, "") + ".";
  return "Challenge service is unavailable.";
}

export function ProfileChallengeControls({
  publicProfileId,
  supabase,
}: ProfileChallengeControlsProps) {
  const router = useRouter();
  const { challenges, refresh } = usePlayerChallenges(supabase);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentChallenge = challenges.find(
    (challenge) =>
      challenge.opponent_public_profile_id === publicProfileId &&
      (challenge.challenge_status === "pending" ||
        challenge.challenge_status === "accepted"),
  );

  useEffect(() => {
    if (
      currentChallenge?.challenge_status !== "accepted" ||
      !currentChallenge.match_id
    ) {
      return;
    }

    if (currentChallenge.match_mode === "ranked") {
      router.push(`/ranked/${currentChallenge.match_id}`);
    } else {
      const search = new URLSearchParams({
        match: currentChallenge.match_id,
        room: currentChallenge.room_code ?? "",
      });
      router.push(`/?${search.toString()}`);
    }
  }, [currentChallenge, router]);

  async function createChallenge(rated: boolean) {
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("create_player_challenge", {
      p_public_profile_id: publicProfileId,
      p_rated: rated,
    });
    setIsWorking(false);
    if (error || !data?.[0]) {
      setMessage(friendlyChallengeError(error?.message));
      return;
    }
    setMessage(
      `${rated ? "Elo-rated" : "Casual"} challenge sent. It expires in 30 seconds.`,
    );
    await refresh();
  }

  async function answerChallenge(accept: boolean) {
    if (!currentChallenge || currentChallenge.direction !== "incoming") return;
    setIsWorking(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("respond_player_challenge", {
      p_challenge_id: currentChallenge.challenge_id,
      p_accept: accept,
    });
    setIsWorking(false);
    if (error || !data?.[0]) {
      setMessage(friendlyChallengeError(error?.message));
      return;
    }
    const response = data[0];
    if (response.challenge_status === "expired") {
      setMessage("Challenge expired.");
    } else if (response.challenge_status === "declined") {
      setMessage("Challenge was declined.");
    }
    await refresh();
  }

  async function cancelChallenge() {
    if (!currentChallenge || currentChallenge.direction !== "outgoing") return;
    setIsWorking(true);
    const { data, error } = await supabase.rpc("cancel_player_challenge", {
      p_challenge_id: currentChallenge.challenge_id,
    });
    setIsWorking(false);
    if (error || !data) {
      setMessage("That challenge could not be cancelled.");
      return;
    }
    setMessage("Challenge cancelled.");
    await refresh();
  }

  return (
    <section className={styles.challengeControls} aria-live="polite">
      <div>
        <strong>Challenge this player</strong>
        <span>Play a shared 4×4, 60-second board.</span>
      </div>
      {currentChallenge?.challenge_status === "pending" ? (
        currentChallenge.direction === "incoming" ? (
          <div>
            <button
              disabled={isWorking}
              onClick={() => void answerChallenge(true)}
              type="button"
            >
              Accept {currentChallenge.rated ? "Elo" : "casual"} challenge
            </button>
            <button
              disabled={isWorking}
              onClick={() => void answerChallenge(false)}
              type="button"
            >
              Decline
            </button>
          </div>
        ) : (
          <div>
            <span>
              {currentChallenge.rated ? "Elo-rated" : "Casual"} challenge
              pending
            </span>
            <button
              disabled={isWorking}
              onClick={() => void cancelChallenge()}
              type="button"
            >
              Cancel
            </button>
          </div>
        )
      ) : (
        <div>
          <button
            disabled={isWorking}
            onClick={() => void createChallenge(true)}
            type="button"
          >
            Challenge for Elo
          </button>
          <button
            disabled={isWorking}
            onClick={() => void createChallenge(false)}
            type="button"
          >
            Challenge casually
          </button>
        </div>
      )}
      {message ? <small role="status">{message}</small> : null}
    </section>
  );
}
