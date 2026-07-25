"use client";

import Link from "next/link";

import { usePlayerAuth } from "@/hooks/use-player-auth";

import styles from "./letter-rush-game.module.css";

export function AppHeader({
  activeMatch = false,
  onActiveNavigate,
}: {
  activeMatch?: boolean;
  onActiveNavigate?: (href: string) => boolean | void | Promise<boolean | void>;
}) {
  const { state, signOut } = usePlayerAuth();

  function handleActiveNavigation(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!activeMatch) return;
    event.preventDefault();

    if (!onActiveNavigate) {
      if (
        window.confirm(
          "Leave this active match? The server will apply this mode's exit rules.",
        )
      ) {
        window.location.assign("/");
      }
      return;
    }

    void (async () => {
      const didExit = await onActiveNavigate("/");
      if (didExit !== false) window.location.assign("/");
    })();
  }

  return (
    <header
      className={`${styles.header} ${activeMatch ? styles.activeHeader : ""}`}
    >
      <Link className={styles.brand} href="/" onClick={handleActiveNavigation}>
        <span className={styles.brandMark} aria-hidden="true">
          LR
        </span>
        <div>
          <strong>Letter Rush</strong>
          <small>Word-grid sprint</small>
        </div>
      </Link>
      {!activeMatch ? (
        <nav className={styles.headerNav} aria-label="Primary">
          <Link href="/leaderboards">Leaderboard</Link>
          {state.status === "ready" ? (
            <>
              <Link href="/profile">{state.displayName}</Link>
              <Link href="/guide">Guide</Link>
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
              <Link href="/guide">Guide</Link>
            </>
          ) : (
            <>
              <Link href="/guide">Guide</Link>
              <Link href="/login">Sign in</Link>
              <Link href="/signup">Create account</Link>
            </>
          )}
        </nav>
      ) : null}
    </header>
  );
}
