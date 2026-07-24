import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Forgot Password | Letter Rush",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <AuthPanel mode="forgot-password" />
    </Suspense>
  );
}
