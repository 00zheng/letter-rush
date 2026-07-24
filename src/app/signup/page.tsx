import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Create Account | Letter Rush",
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return (
    <Suspense>
      <AuthPanel mode="signup" />
    </Suspense>
  );
}
