"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

import { AppHeader } from "@/components/app-header";
import { ProfileChallengeControls } from "@/components/profile-challenge-controls";
import { usePlayerAuth } from "@/hooks/use-player-auth";
import { createPublicProfileUrl } from "@/lib/app-url";
import type { Database } from "@/lib/supabase/database.types";
import {
  getInitials,
  isValidPublicProfileId,
  normalizePublicProfileId,
} from "@/ranked/profile";
import type {
  LeaderboardEntry,
  PublicRankedMatch,
  PublicRankedProfile,
  RankedPlacement,
} from "@/ranked/types";

import styles from "./ranked.module.css";

type LeaderboardCategory = "rating" | "best-score" | "wins";
type PublicModeStat =
  Database["public"]["Functions"]["get_public_player_mode_stats"]["Returns"][number];

const CATEGORIES: {
  value: LeaderboardCategory;
  label: string;
  metricLabel: string;
}[] = [
  { value: "rating", label: "Rating", metricLabel: "Rating" },
  {
    value: "best-score",
    label: "Best score",
    metricLabel: "Best score",
  },
  { value: "wins", label: "Wins", metricLabel: "Wins" },
];

function categoryOrDefault(value: string): LeaderboardCategory {
  return CATEGORIES.some((category) => category.value === value)
    ? (value as LeaderboardCategory)
    : "rating";
}

export function LeaderboardClient({
  initialCategory,
  page,
}: {
  initialCategory: string;
  page: number;
}) {
  const category = categoryOrDefault(initialCategory);
  const { state: auth, supabase, retry } = usePlayerAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [placement, setPlacement] = useState<RankedPlacement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void (async () => {
      const { data, error: listError } = await supabase.rpc(
        "get_ranked_leaderboard",
        {
          p_category: category,
          p_page: page,
        },
      );
      const placementResult =
        auth.status === "ready"
          ? await supabase.rpc("get_current_ranked_placement", {
              p_category: category,
            })
          : { data: null, error: null };
      if (!active) return;
      if (listError || placementResult.error) {
        setError("The leaderboard could not be loaded. Retry shortly.");
      } else {
        setEntries(data ?? []);
        setPlacement(placementResult.data?.[0] ?? null);
        setError(null);
      }
      setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [auth.status, category, page, retryNonce, supabase]);

  const categoryMeta = CATEGORIES.find(
    (candidate) => candidate.value === category,
  )!;
  const totalPlayers = entries[0]?.total_players ?? placement?.total_players;
  const hasNext = totalPlayers ? page * 25 < totalPlayers : false;

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.page}>
        <div className={styles.pageHeader}>
          <div>
            <p className={styles.kicker}>All-time ranked</p>
            <h1>Leaderboards</h1>
          </div>
          <Link href="/">Menu</Link>
        </div>
        <nav className={styles.tabs} aria-label="Leaderboard category">
          {CATEGORIES.map((item) => (
            <Link
              aria-current={item.value === category ? "page" : undefined}
              href={`/leaderboards?category=${item.value}`}
              key={item.value}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {placement ? (
          <p className={styles.placement}>
            Your placement: #{placement.competition_rank} ·{" "}
            {placement.metric_value.toLocaleString("en-US")}{" "}
            {categoryMeta.metricLabel.toLowerCase()}
          </p>
        ) : null}

        {auth.status !== "ready" ? (
          <div className={styles.error}>
            <p>{auth.message}</p>
            {auth.status === "error" ? (
              <button type="button" onClick={retry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : isLoading ? (
          <p role="status">Loading ranked players…</p>
        ) : error ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => setRetryNonce((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : entries.length ? (
          <div className={styles.tableScroller}>
            <table className={styles.leaderboard}>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Player</th>
                  <th>Games</th>
                  <th>{categoryMeta.metricLabel}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    className={
                      auth.publicProfileId === entry.public_profile_id
                        ? styles.currentRow
                        : ""
                    }
                    key={entry.public_profile_id}
                  >
                    <td>#{entry.competition_rank}</td>
                    <td>
                      <span className={styles.playerCell}>
                        <i className={styles.avatar} aria-hidden="true">
                          {getInitials(entry.display_name)}
                        </i>
                        <Link href={`/players/${entry.public_profile_id}`}>
                          {entry.display_name}
                        </Link>
                      </span>
                    </td>
                    <td>{entry.games_played}</td>
                    <td>{entry.metric_value.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No ranked matches have been completed yet.</p>
        )}

        <nav className={styles.pager} aria-label="Leaderboard pages">
          {page > 1 ? (
            <Link href={`/leaderboards?category=${category}&page=${page - 1}`}>
              Previous
            </Link>
          ) : null}
          {hasNext ? (
            <Link href={`/leaderboards?category=${category}&page=${page + 1}`}>
              Next
            </Link>
          ) : null}
        </nav>
      </section>
    </main>
  );
}

function ProfileContent({
  profile,
  history,
  modeStats,
  isCurrentPlayer,
  challengeControls,
}: {
  profile: PublicRankedProfile;
  history: PublicRankedMatch[];
  modeStats: PublicModeStat[];
  isCurrentPlayer: boolean;
  challengeControls?: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const winRate = profile.games_played
    ? Math.round((profile.wins / profile.games_played) * 100)
    : 0;
  const bestModeScores = [
    { category: "solo", label: "Single Player" },
    { category: "ranked", label: "Ranked" },
    { category: "private", label: "Private Lobby" },
  ].map(({ category, label }) => ({
    category,
    label,
    record: modeStats
      .filter((mode) => mode.category === category)
      .sort((first, second) => second.best_score - first.best_score)[0],
  }));
  return (
    <>
      <div className={styles.pageHeader}>
        <div className={styles.profileHeading}>
          <i className={styles.profileAvatar} aria-hidden="true">
            {getInitials(profile.display_name)}
          </i>
          <div>
            <p className={styles.profileId}>
              Player {profile.public_profile_id}
            </p>
            <h1>{profile.display_name}</h1>
            {isCurrentPlayer ? <strong>This is you</strong> : null}
          </div>
        </div>
        <div className={styles.profileActions}>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  createPublicProfileUrl(profile.public_profile_id),
                );
                setCopyStatus("Profile link copied.");
              } catch {
                setCopyStatus("Clipboard access was blocked.");
              }
            }}
          >
            Copy profile link
          </button>
          <Link href="/leaderboards">Leaderboards</Link>
          {copyStatus ? <small role="status">{copyStatus}</small> : null}
        </div>
      </div>
      {challengeControls}
      <dl className={styles.profileStats}>
        <div>
          <dt>Rating</dt>
          <dd>{profile.current_rating}</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>{profile.peak_rating}</dd>
        </div>
        <div>
          <dt>Rank</dt>
          <dd>{profile.rating_rank ? `#${profile.rating_rank}` : "—"}</dd>
        </div>
        <div>
          <dt>Games</dt>
          <dd>{profile.games_played}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            {profile.wins}-{profile.losses}-{profile.ties}
          </dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd>{winRate}%</dd>
        </div>
        <div>
          <dt>Best score</dt>
          <dd>{profile.best_score.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Current streak</dt>
          <dd>{profile.current_win_streak}</dd>
        </div>
        <div>
          <dt>Best streak</dt>
          <dd>{profile.best_win_streak}</dd>
        </div>
        <div>
          <dt>Ranked since</dt>
          <dd>
            {new Date(profile.ranked_since).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </dd>
        </div>
      </dl>
      <h2>Recent ranked matches</h2>
      <div className={styles.history}>
        {history.map((match) => (
          <article key={match.match_public_id}>
            <div>
              <strong>{match.result_status}</strong>
              <p>
                vs.{" "}
                <Link href={`/players/${match.opponent_public_profile_id}`}>
                  {match.opponent_display_name}
                </Link>
              </p>
            </div>
            <div>
              <strong>
                {match.player_score.toLocaleString("en-US")}–{" "}
                {match.opponent_score.toLocaleString("en-US")}
              </strong>
              <p>
                {match.rating_delta > 0 ? "+" : ""}
                {match.rating_delta} → {match.rating_after}
              </p>
            </div>
            <span>
              {new Date(match.completed_at).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          </article>
        ))}
        {!history.length ? <p>No rated matches yet.</p> : null}
      </div>
      <h2>Best scores by mode</h2>
      <dl className={styles.profileStats}>
        {bestModeScores.map(({ category, label, record }) => (
          <div key={category}>
            <dt>{label}</dt>
            <dd>{record ? record.best_score.toLocaleString("en-US") : "—"}</dd>
          </div>
        ))}
      </dl>
      <h2>View all mode records</h2>
      <div className={styles.history}>
        {modeStats.map((mode) => (
          <article key={mode.mode_key}>
            <div>
              <strong>{mode.display_label}</strong>
              <p>Updated {new Date(mode.updated_at).toLocaleDateString()}</p>
            </div>
            <div>
              <strong>Best {mode.best_score.toLocaleString("en-US")}</strong>
              <p>
                {mode.games_played} games · {mode.total_words} words
              </p>
            </div>
            <span>{mode.best_word ?? "No best word yet"}</span>
          </article>
        ))}
        {!modeStats.length ? <p>No saved mode results yet.</p> : null}
      </div>
      <div className={styles.actions}>
        <Link href="/quick-match">Quick Match</Link>
        <Link href="/">Menu</Link>
      </div>
    </>
  );
}

export function PlayerProfileClient({
  publicProfileId,
}: {
  publicProfileId: string;
}) {
  const normalizedId = normalizePublicProfileId(publicProfileId);
  const hasValidPublicId = isValidPublicProfileId(normalizedId);
  const { state: auth, supabase, retry } = usePlayerAuth();
  const [profile, setProfile] = useState<PublicRankedProfile | null>(null);
  const [history, setHistory] = useState<PublicRankedMatch[]>([]);
  const [modeStats, setModeStats] = useState<PublicModeStat[]>([]);
  const [isLoading, setIsLoading] = useState(hasValidPublicId);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    if (!hasValidPublicId) return;
    let active = true;
    void (async () => {
      const [
        { data: profileData, error: profileError },
        { data: historyData, error: historyError },
        { data: modeData, error: modeError },
      ] = await Promise.all([
        supabase.rpc("get_public_player_profile", {
          p_public_profile_id: normalizedId,
        }),
        supabase.rpc("get_public_ranked_matches", {
          p_public_profile_id: normalizedId,
          p_limit: 3,
        }),
        supabase.rpc("get_public_player_mode_stats", {
          p_public_profile_id: normalizedId,
          p_page: 1,
        }),
      ]);
      if (!active) return;
      if (profileError || historyError || modeError || !profileData?.[0]) {
        setError(
          profileError || historyError || modeError
            ? "The player profile could not be loaded. Retry shortly."
            : "That ranked player was not found.",
        );
      } else {
        setProfile(profileData[0]);
        setHistory(historyData ?? []);
        setModeStats(modeData ?? []);
        setError(null);
      }
      setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [hasValidPublicId, normalizedId, retryNonce, supabase]);

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.page}>
        {!supabase ? (
          <>
            <h1>Player profile</h1>
            <p>{auth.message}</p>
            {auth.status === "error" ? (
              <button type="button" onClick={retry}>
                Retry
              </button>
            ) : null}
          </>
        ) : isLoading ? (
          <p role="status">Loading player profile…</p>
        ) : error || !profile ? (
          <>
            <h1>Player not found.</h1>
            <p role="alert">
              {hasValidPublicId ? error : "That player ID is invalid."}
            </p>
            {hasValidPublicId ? (
              <button
                type="button"
                onClick={() => setRetryNonce((value) => value + 1)}
              >
                Retry
              </button>
            ) : null}
            <Link href="/leaderboards">View leaderboards</Link>
          </>
        ) : (
          <ProfileContent
            challengeControls={
              auth.status === "ready" &&
              auth.publicProfileId !== profile.public_profile_id ? (
                <ProfileChallengeControls
                  publicProfileId={profile.public_profile_id}
                  supabase={supabase}
                />
              ) : undefined
            }
            history={history}
            modeStats={modeStats}
            isCurrentPlayer={
              auth.status === "ready" &&
              auth.publicProfileId === profile.public_profile_id
            }
            profile={profile}
          />
        )}
      </section>
    </main>
  );
}

export function CurrentProfileClient() {
  const router = useRouter();
  const { state: auth } = usePlayerAuth();
  useEffect(() => {
    if (auth.status === "ready") {
      router.replace(`/players/${auth.publicProfileId}`);
    }
  }, [auth, router]);

  return (
    <main className={styles.appShell}>
      <AppHeader />
      <section className={styles.statusCard}>
        <p className={styles.kicker}>Your ranked profile</p>
        <h1>
          {auth.status === "ready"
            ? "Opening your player card."
            : "Preparing your player card."}
        </h1>
        <p>{auth.message}</p>
      </section>
    </main>
  );
}
