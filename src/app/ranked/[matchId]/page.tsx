import type { Metadata } from "next";

import { RankedMatchRoom } from "@/components/ranked-match-room";

export const metadata: Metadata = {
  title: "Ranked Match | Letter Rush",
  robots: { index: false, follow: false },
};

export default async function RankedMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  return <RankedMatchRoom matchId={matchId} />;
}
