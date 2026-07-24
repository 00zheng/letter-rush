import type { Metadata } from "next";

import { QuickMatchClient } from "@/components/quick-match-client";

export const metadata: Metadata = {
  title: "Ranked Quick Match | Letter Rush",
  description: "Find one opponent for a fixed, fair 60-second ranked round.",
  alternates: { canonical: "/quick-match" },
};

export default function QuickMatchPage() {
  return <QuickMatchClient />;
}
