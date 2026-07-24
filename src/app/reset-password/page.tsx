import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Reset Password | Letter Rush",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <AuthPanel mode="reset-password" />
    </Suspense>
  );
}
