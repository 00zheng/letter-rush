import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Sign In | Letter Rush",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <Suspense>
      <AuthPanel mode="login" />
    </Suspense>
  );
}
