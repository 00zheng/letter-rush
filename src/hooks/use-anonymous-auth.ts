"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createBrowserSupabaseClient,
  type BrowserSupabaseClient,
} from "@/lib/supabase/client";
import { getSupabaseEnvironment } from "@/lib/supabase/config";
import { validateDisplayName } from "@/multiplayer/display-name";

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

      const { data: identities, error: identityError } = await supabase.rpc(
        "ensure_current_player_identity",
      );

      if (identityError) throw identityError;

      const identity = identities?.[0];

      if (!identity?.display_name || !identity.public_profile_id) {
        throw new Error("Supabase did not return a complete player identity.");
      }

      setState({
        status: "ready",
        user,
        displayName: identity.display_name,
        publicProfileId: identity.public_profile_id,
        isSavingName: false,
        message: null,
      });
    } catch {
      setState({
        status: "error",
        message:
          "We couldn't prepare your player profile. Please try again. Single Player is still available.",
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
