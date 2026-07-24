"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createBrowserSupabaseClient,
  type BrowserSupabaseClient,
} from "@/lib/supabase/client";
import { getSupabaseEnvironment } from "@/lib/supabase/config";
import {
  createGuestName,
  validateDisplayName,
} from "@/multiplayer/display-name";

type AnonymousAuthState =
  | { status: "loading"; message: string }
  | { status: "disabled"; message: string }
  | { status: "error"; message: string }
  | {
      status: "ready";
      user: User;
      displayName: string;
      publicProfileId: string;
      isSavingName: boolean;
      message: string | null;
    };

export function useAnonymousAuth() {
  const clientRef = useRef<BrowserSupabaseClient | null>(null);
  const [supabase, setSupabase] = useState<BrowserSupabaseClient | null>(null);
  const [state, setState] = useState<AnonymousAuthState>({
    status: "loading",
    message: "Preparing private matches…",
  });

  const initialize = useCallback(async () => {
    const environment = getSupabaseEnvironment();

    if (!environment.isConfigured) {
      setState({
        status: "disabled",
        message: `Private matches need ${environment.missing.join(
          " and ",
        )} in .env.local. Single Player is still available.`,
      });
      return;
    }

    setState({
      status: "loading",
      message: "Preparing your guest session…",
    });

    try {
      const supabase = clientRef.current ?? createBrowserSupabaseClient();
      clientRef.current = supabase;
      setSupabase(supabase);

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) throw sessionError;

      let user = session?.user ?? null;

      if (!user) {
        const { data, error } = await supabase.auth.signInAnonymously();

        if (error) throw error;
        user = data.user;
      }

      if (!user) {
        throw new Error("Supabase did not return an anonymous user.");
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("display_name, public_profile_id")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      let displayName = profile?.display_name;
      let publicProfileId = profile?.public_profile_id;

      if (!displayName) {
        displayName = createGuestName(user.id);
        const { error: insertError } = await supabase.from("profiles").insert({
          id: user.id,
          display_name: displayName,
        });

        if (insertError && insertError.code !== "23505") {
          throw insertError;
        }

        const { data: restoredProfile, error: restoredProfileError } =
          await supabase
            .from("profiles")
            .select("display_name, public_profile_id")
            .eq("id", user.id)
            .single();
        if (restoredProfileError) throw restoredProfileError;
        displayName = restoredProfile.display_name;
        publicProfileId = restoredProfile.public_profile_id;
      }

      if (!publicProfileId) {
        throw new Error(
          "Your public player profile is not initialized. Apply the ranked migration.",
        );
      }

      setState({
        status: "ready",
        user,
        displayName,
        publicProfileId,
        isSavingName: false,
        message: null,
      });
    } catch (error) {
      setState({
        status: "error",
        message: `${
          error instanceof Error
            ? error.message
            : "Supabase could not be reached."
        } Single Player is still available.`,
      });
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void initialize(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [initialize]);

  const updateDisplayName = useCallback(
    async (value: string): Promise<boolean> => {
      if (state.status !== "ready" || !clientRef.current) return false;

      const validation = validateDisplayName(value);

      if (!validation.isValid) {
        setState({ ...state, message: validation.message });
        return false;
      }

      setState({ ...state, isSavingName: true, message: null });

      const { error } = await clientRef.current
        .from("profiles")
        .update({ display_name: validation.displayName })
        .eq("id", state.user.id);

      if (error) {
        setState({
          ...state,
          isSavingName: false,
          message: error.message,
        });
        return false;
      }

      setState({
        ...state,
        displayName: validation.displayName,
        publicProfileId: state.publicProfileId,
        isSavingName: false,
        message: "Display name saved.",
      });
      return true;
    },
    [state],
  );

  return {
    state,
    supabase,
    retry: initialize,
    updateDisplayName,
  };
}
