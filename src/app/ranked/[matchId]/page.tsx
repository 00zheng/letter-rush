import type { Metadata } from "next";

import { requirePersistentUser } from "@/auth/server";
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
  await requirePersistentUser(`/ranked/${matchId}`);
  return <RankedMatchRoom matchId={matchId} />;
}
