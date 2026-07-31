"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePlayerAuth } from "@/hooks/use-player-auth";

import styles from "./letter-rush-game.module.css";

type NavIconName =
  "leaderboard" | "profile" | "guide" | "sign-in" | "sign-out" | "create";

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, React.ReactNode> = {
    leaderboard: (
      <>
        <path d="M5 19V9" />
        <path d="M12 19V5" />
        <path d="M19 19v-7" />
      </>
    ),
    profile: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M5.5 19c.7-3.4 3-5 6.5-5s5.8 1.6 6.5 5" />
      </>
    ),
    guide: (
      <>
        <path d="M4.5 5.5A3.5 3.5 0 0 1 8 9h4v10H8a3.5 3.5 0 0 0-3.5 3.5Z" />
        <path d="M19.5 5.5A3.5 3.5 0 0 0 16 9h-4v10h4a3.5 3.5 0 0 1 3.5 3.5Z" />
      </>
    ),
    "sign-in": (
      <>
        <path d="M10 5H5v14h5" />
        <path d="m13 8 4 4-4 4" />
        <path d="M8 12h9" />
      </>
    ),
    "sign-out": (
      <>
        <path d="M14 5h5v14h-5" />
        <path d="m11 8-4 4 4 4" />
        <path d="M16 12H7" />
      </>
    ),
    create: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.6-3.3 2.5-5 5.5-5 1.1 0 2 .2 2.8.7" />
        <path d="M17 13v6M14 16h6" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className={styles.navIcon}
      fill="none"
      viewBox="0 0 24 24"
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

function NavLink({
  active,
  href,
  icon,
  label,
  mobileLabel = label,
}: {
  active: boolean;
  href: string;
  icon: NavIconName;
  label: string;
  mobileLabel?: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={styles.navItem}
      href={href}
    >
      <NavIcon name={icon} />
      <span className={styles.desktopNavLabel}>{label}</span>
      <span className={styles.mobileNavLabel}>{mobileLabel}</span>
    </Link>
  );
}

export function AppHeader({
  activeMatch = false,
  onActiveNavigate,
}: {
  activeMatch?: boolean;
  onActiveNavigate?: (href: string) => boolean | void | Promise<boolean | void>;
}) {
  const { state, signOut } = usePlayerAuth();
  const pathname = usePathname();

  function isActive(href: string) {
    return href === "/"
      ? pathname === href
      : (pathname?.startsWith(href) ?? false);
  }

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
          <NavLink
            active={isActive("/leaderboards")}
            href="/leaderboards"
            icon="leaderboard"
            label="Leaderboard"
          />
          {state.status === "ready" ? (
            <>
              <NavLink
                active={isActive("/profile")}
                href="/profile"
                icon="profile"
                label={state.displayName}
                mobileLabel="Profile"
              />
              <NavLink
                active={isActive("/guide")}
                href="/guide"
                icon="guide"
                label="Guide"
              />
              <button
                className={styles.navItem}
                type="button"
                onClick={() => void signOut()}
              >
                <NavIcon name="sign-out" />
                <span className={styles.desktopNavLabel}>Sign out</span>
                <span className={styles.mobileNavLabel}>Sign out</span>
              </button>
            </>
          ) : state.status === "anonymous" ? (
            <>
              {state.publicProfileId ? (
                <NavLink
                  active={isActive("/players")}
                  href={`/players/${state.publicProfileId}`}
                  icon="profile"
                  label={state.displayName ?? "Profile"}
                  mobileLabel="Profile"
                />
              ) : null}
              <NavLink
                active={isActive("/claim-account")}
                href="/claim-account"
                icon="create"
                label="Claim account"
                mobileLabel="Claim"
              />
              <NavLink
                active={isActive("/guide")}
                href="/guide"
                icon="guide"
                label="Guide"
              />
            </>
          ) : (
            <>
              <NavLink
                active={isActive("/guide")}
                href="/guide"
                icon="guide"
                label="Guide"
              />
              <NavLink
                active={isActive("/login")}
                href="/login"
                icon="sign-in"
                label="Sign in"
              />
              <NavLink
                active={isActive("/signup")}
                href="/signup"
                icon="create"
                label="Create account"
                mobileLabel="Create"
              />
            </>
          )}
        </nav>
      ) : null}
    </header>
  );
}
