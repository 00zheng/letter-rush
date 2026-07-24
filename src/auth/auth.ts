import type { AuthError } from "@supabase/supabase-js";

export const PASSWORD_MINIMUM_LENGTH = 10;

export type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too weak" | "Weak" | "Fair" | "Good" | "Strong";
  isAcceptable: boolean;
};

export function validateEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

export function getPasswordStrength(password: string): PasswordStrength {
  let points = 0;
  if (password.length >= PASSWORD_MINIMUM_LENGTH) points += 1;
  if (password.length >= 14) points += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) points += 1;

  const score = Math.min(4, points) as PasswordStrength["score"];
  const labels: PasswordStrength["label"][] = [
    "Too weak",
    "Weak",
    "Fair",
    "Good",
    "Strong",
  ];
  return {
    score,
    label: labels[score],
    isAcceptable: password.length >= PASSWORD_MINIMUM_LENGTH && score >= 2,
  };
}

export function safeNextPath(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(value, "https://letter-rush.invalid");
    return parsed.origin === "https://letter-rush.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export function friendlyAuthError(error: unknown): string {
  const authError = error as Partial<AuthError> | null;
  const code = authError?.code ?? "";

  switch (code) {
    case "invalid_credentials":
      return "That email and password combination was not recognized.";
    case "email_not_confirmed":
      return "Confirm your email before signing in.";
    case "user_already_exists":
    case "email_exists":
      return "An account already uses that email. Try signing in instead.";
    case "weak_password":
      return "Choose a stronger password with at least 10 characters.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Too many attempts. Wait a little while, then try again.";
    case "same_password":
      return "Choose a password you have not used for this account.";
    case "session_not_found":
    case "bad_jwt":
      return "That session has expired. Sign in and try again.";
    case "otp_expired":
      return "That email link has expired. Request a new one.";
    case "validation_failed":
      return "Check the highlighted account details and try again.";
    default:
      return "Account service is temporarily unavailable. Please try again.";
  }
}

export function isAnonymousUser(user: {
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown>;
}): boolean {
  return (
    user.is_anonymous === true ||
    user.app_metadata?.provider === "anonymous" ||
    user.app_metadata?.is_anonymous === true
  );
}
