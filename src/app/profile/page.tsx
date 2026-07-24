import type { Metadata } from "next";

import { CurrentProfileClient } from "@/components/ranked-pages";

export const metadata: Metadata = {
  title: "Your Ranked Profile | Letter Rush",
  robots: { index: false, follow: false },
};

export default function ProfilePage() {
  return <CurrentProfileClient />;
}
