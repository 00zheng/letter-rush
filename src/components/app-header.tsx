"use client";

import Link from "next/link";

import { usePlayerAuth } from "@/hooks/use-player-auth";

import styles from "./letter-rush-game.module.css";

export function AppHeader({ activeMatch = false }: { activeMatch?: boolean }) {
  const { state, signOut } = usePlayerAuth();

  function confirmActiveNavigation(event: React.MouseEvent) {
    if (
      activeMatch &&
      !window.confirm(
        "Leave this active match? Your round will keep running on the server.",
      )
    ) {
      event.preventDefault();
    }
  }

  return (
    <header className={styles.header}>
      <Link className={styles.brand} href="/" onClick={confirmActiveNavigation}>
        <span className={styles.brandMark} aria-hidden="true">
          LR
        </span>
        <div>
          <strong>Letter Rush</strong>
          <small>Word-grid sprint</small>
        </div>
      </Link>
      <nav className={styles.headerNav} aria-label="Primary">
        <Link href="/guide">Guide</Link>
        <Link href="/leaderboards">Leaderboard</Link>
        {state.status === "ready" ? (
          <>
            <Link href="/profile">{state.displayName}</Link>
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        ) : state.status === "anonymous" ? (
          <>
            {state.publicProfileId ? (
              <Link href={`/players/${state.publicProfileId}`}>
                {state.displayName ?? "Profile"}
              </Link>
            ) : null}
            <Link href="/claim-account">Claim account</Link>
          </>
        ) : (
          <>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create account</Link>
          </>
        )}
      </nav>
    </header>
  );
}
