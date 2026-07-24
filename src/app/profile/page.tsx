import type { Metadata } from "next";

import { requirePersistentUser } from "@/auth/server";
import { CurrentProfileClient } from "@/components/ranked-pages";

export const metadata: Metadata = {
  title: "Your Ranked Profile | Letter Rush",
  robots: { index: false, follow: false },
};

export default async function ProfilePage() {
  await requirePersistentUser("/profile");
  return <CurrentProfileClient />;
}
