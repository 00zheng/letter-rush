import type { Metadata } from "next";

import { LeaderboardClient } from "@/components/ranked-pages";

export const metadata: Metadata = {
  title: "Ranked Leaderboards | Letter Rush",
  description:
    "All-time Letter Rush rankings by Elo rating, best score, and wins.",
  alternates: { canonical: "/leaderboards" },
};

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; page?: string }>;
}) {
  const query = await searchParams;
  const requestedPage = Number.parseInt(query.page ?? "1", 10);
  return (
    <LeaderboardClient
      initialCategory={query.category ?? "rating"}
      page={
        Number.isFinite(requestedPage)
          ? Math.max(1, Math.min(requestedPage, 10_000))
          : 1
      }
    />
  );
}
