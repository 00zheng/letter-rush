"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import {
  friendlyAuthError,
  getPasswordStrength,
  safeNextPath,
  validateEmail,
} from "@/auth/auth";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getSupabaseEnvironment } from "@/lib/supabase/config";
import { validateDisplayName } from "@/multiplayer/display-name";

import { AppHeader } from "./app-header";
import styles from "./auth-panel.module.css";

export type AuthMode =
  "login" | "signup" | "forgot-password" | "reset-password" | "claim-account";

const CONTENT: Record<
  AuthMode,
  { kicker: string; title: string; lead: string; submit: string }
> = {
  login: {
    kicker: "Welcome back",
    title: "Sign in.",
    lead: "Restore your profile, saved mode statistics, rating, and matches.",
    submit: "Sign in",
  },
  signup: {
    kicker: "Persistent player",
    title: "Create account.",
    lead: "Choose a public display name and secure your progress with email.",
    submit: "Create account",
  },
  "forgot-password": {
    kicker: "Account recovery",
    title: "Reset password.",
    lead: "We will email a time-limited recovery link if the account exists.",
    submit: "Send recovery link",
  },
  "reset-password": {
    kicker: "Account recovery",
    title: "Choose a password.",
    lead: "Use a strong password you do not reuse on another service.",
    submit: "Save new password",
  },
  "claim-account": {
    kicker: "Keep your history",
    title: "Claim guest account.",
    lead: "Add and verify an email, then set a password without changing your player identity.",
    submit: "Send verification email",
  },
};

export function AuthPanel({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    searchParams.get("error")
      ? "That email link is invalid or expired. Request a new one."
      : null,
  );
  const [claimStage, setClaimStage] = useState<"email" | "password">("email");
  const content = CONTENT[mode];
  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const environment = getSupabaseEnvironment();
  const next = safeNextPath(searchParams.get("next"));

  useEffect(() => {
    if (mode !== "claim-account" || !environment.isConfigured) return;
    const supabase = createBrowserSupabaseClient();
    void supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      if (user && !user.is_anonymous && user.email) {
        setEmail(user.email);
        setClaimStage("password");
      }
    });
  }, [environment.isConfigured, mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!environment.isConfigured) {
      setError("Account service is not configured on this installation.");
      return;
    }

    const normalizedEmail = validateEmail(email);
    if (
      mode !== "reset-password" &&
      !(mode === "claim-account" && claimStage === "password") &&
      !normalizedEmail
    ) {
      setError("Enter a valid email address.");
      return;
    }

    if (mode === "signup") {
      const nameValidation = validateDisplayName(displayName);
      if (!nameValidation.isValid) {
        setError(nameValidation.message);
        return;
      }
    }

    if (
      ["login", "signup", "reset-password"].includes(mode) ||
      (mode === "claim-account" && claimStage === "password")
    ) {
      if (mode !== "login" && !strength.isAcceptable) {
        setError(
          "Use at least 10 characters and a stronger mix of characters.",
        );
        return;
      }
      if (!password) {
        setError("Enter your password.");
        return;
      }
      if (mode === "signup" && password !== passwordConfirmation) {
        setError("Passwords do not match.");
        return;
      }
    }

    setIsWorking(true);
    const supabase = createBrowserSupabaseClient();
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: normalizedEmail!,
          password,
        });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else if (mode === "signup") {
        const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(
          next,
        )}`;
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail!,
          password,
          options: {
            emailRedirectTo: redirectTo,
            data: { display_name: displayName.trim() },
          },
        });
        if (error) throw error;
        if (data.session) {
          router.replace(next);
          router.refresh();
        } else {
          setMessage(
            "Check your email to confirm the account, then return to sign in.",
          );
        }
      } else if (mode === "forgot-password") {
        const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
        const { error } = await supabase.auth.resetPasswordForEmail(
          normalizedEmail!,
          { redirectTo },
        );
        if (error) throw error;
        setMessage(
          "If that account exists, a recovery link is on its way. Check spam too.",
        );
      } else if (mode === "reset-password") {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          setError("Open a fresh recovery link before choosing a password.");
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMessage("Password updated. You can return to Letter Rush.");
      } else if (claimStage === "email") {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          setError(
            "Open Claim Account from the browser that holds your guest session.",
          );
          return;
        }
        if (!user.is_anonymous) {
          setClaimStage("password");
          return;
        }
        const redirectTo = `${window.location.origin}/auth/callback?next=/claim-account`;
        const { error } = await supabase.auth.updateUser(
          { email: normalizedEmail! },
          { emailRedirectTo: redirectTo },
        );
        if (error) throw error;
        setMessage(
          "Verify the email from this device. Your guest profile stays attached to the same account.",
        );
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMessage(
          "Account claimed. Your player ID and history are preserved.",
        );
        window.setTimeout(() => {
          router.replace("/");
          router.refresh();
        }, 800);
      }
    } catch (authError) {
      setError(friendlyAuthError(authError));
    } finally {
      setIsWorking(false);
    }
  }

  const needsEmail =
    mode !== "reset-password" &&
    !(mode === "claim-account" && claimStage === "password");
  const needsPassword =
    mode === "login" ||
    mode === "signup" ||
    mode === "reset-password" ||
    (mode === "claim-account" && claimStage === "password");
  const submitLabel =
    mode === "claim-account" && claimStage === "password"
      ? "Finish claiming account"
      : content.submit;

  async function resendSignupConfirmation() {
    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail) {
      setError("Enter the email used for signup.");
      return;
    }
    setIsWorking(true);
    const supabase = createBrowserSupabaseClient();
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email: normalizedEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
          next,
        )}`,
      },
    });
    setIsWorking(false);
    setError(resendError ? friendlyAuthError(resendError) : null);
    if (!resendError) setMessage("A new confirmation email is on its way.");
  }

  return (
    <main className={styles.shell}>
      <AppHeader />
      <section className={styles.card}>
        <p className={styles.kicker}>{content.kicker}</p>
        <h1>{content.title}</h1>
        <p className={styles.lead}>{content.lead}</p>
        <form className={styles.form} onSubmit={submit} noValidate>
          {mode === "signup" ? (
            <label>
              Display name
              <input
                autoComplete="nickname"
                maxLength={24}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </label>
          ) : null}
          {needsEmail ? (
            <label>
              Email
              <input
                autoComplete="email"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
          ) : null}
          {needsPassword ? (
            <label>
              {mode === "login" ? "Password" : "New password"}
              <span className={styles.passwordRow}>
                <input
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  minLength={10}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type={showPassword ? "text" : "password"}
                  value={password}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((shown) => !shown)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </span>
              {mode !== "login" ? (
                <>
                  <span
                    className={styles.strength}
                    aria-label={`Password strength: ${strength.label}`}
                  >
                    {[1, 2, 3, 4].map((step) => (
                      <i
                        data-active={step <= strength.score}
                        key={step}
                        aria-hidden="true"
                      />
                    ))}
                  </span>
                  <small className={styles.strengthText}>
                    {strength.label} · at least 10 characters
                  </small>
                </>
              ) : null}
            </label>
          ) : null}
          {mode === "signup" ? (
            <label>
              Confirm password
              <input
                autoComplete="new-password"
                minLength={10}
                onChange={(event) =>
                  setPasswordConfirmation(event.target.value)
                }
                required
                type={showPassword ? "text" : "password"}
                value={passwordConfirmation}
              />
            </label>
          ) : null}
          {message ? (
            <p className={styles.message} role="status">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <button className={styles.primary} disabled={isWorking} type="submit">
            {isWorking ? "Working…" : submitLabel}
          </button>
          {mode === "signup" && message ? (
            <button
              className={styles.secondary}
              disabled={isWorking}
              onClick={() => void resendSignupConfirmation()}
              type="button"
            >
              Resend confirmation
            </button>
          ) : null}
        </form>
        <nav className={styles.links} aria-label="Account links">
          {mode !== "login" ? <Link href="/login">Sign in</Link> : null}
          {mode !== "signup" ? (
            <Link href="/signup">Create account</Link>
          ) : null}
          {mode !== "forgot-password" ? (
            <Link href="/forgot-password">Forgot password?</Link>
          ) : null}
          <Link href="/">Return home</Link>
        </nav>
      </section>
    </main>
  );
}
