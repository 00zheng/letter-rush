import type { Metadata } from "next";

import { PlayerProfileClient } from "@/components/ranked-pages";
import {
  isValidPublicProfileId,
  normalizePublicProfileId,
} from "@/ranked/profile";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicProfileId: string }>;
}): Promise<Metadata> {
  const { publicProfileId } = await params;
  const normalizedId = normalizePublicProfileId(publicProfileId);
  return {
    title: "Ranked Player | Letter Rush",
    description: "Public Letter Rush ranked statistics and recent results.",
    alternates: isValidPublicProfileId(normalizedId)
      ? { canonical: `/players/${normalizedId}` }
      : undefined,
    robots: isValidPublicProfileId(normalizedId)
      ? undefined
      : { index: false, follow: false },
  };
}

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ publicProfileId: string }>;
}) {
  const { publicProfileId } = await params;
  return <PlayerProfileClient publicProfileId={publicProfileId} />;
}
