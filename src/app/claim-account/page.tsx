import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Claim Guest Account | Letter Rush",
  robots: { index: false, follow: false },
};

export default function ClaimAccountPage() {
  return (
    <Suspense>
      <AuthPanel mode="claim-account" />
    </Suspense>
  );
}
