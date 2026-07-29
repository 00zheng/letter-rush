"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { friendlyAuthError, isAnonymousUser } from "@/auth/auth";
import {
  createBrowserSupabaseClient,
  type BrowserSupabaseClient,
} from "@/lib/supabase/client";
import { getSupabaseEnvironment } from "@/lib/supabase/config";

type PlayerAuthState =
  | { status: "loading"; message: string }
  | { status: "disabled"; message: string }
  | { status: "signed-out"; message: string }
  | {
      status: "anonymous";
      user: User;
      displayName: string | null;
      publicProfileId: string | null;
      message: string;
    }
  | { status: "error"; message: string }
  | {
      status: "ready";
      user: User;
      displayName: string;
      publicProfileId: string;
      message: string | null;
    };

let sharedBrowserClient: BrowserSupabaseClient | null = null;

function getSharedClient(): BrowserSupabaseClient {
  sharedBrowserClient ??= createBrowserSupabaseClient();
  return sharedBrowserClient;
}

export function usePlayerAuth() {
  const clientRef = useRef<BrowserSupabaseClient | null>(null);
  const [supabase, setSupabase] = useState<BrowserSupabaseClient | null>(null);
  const [state, setState] = useState<PlayerAuthState>({
    status: "loading",
    message: "Checking your account…",
  });

  const initialize = useCallback(async () => {
    const environment = getSupabaseEnvironment();
    if (!environment.isConfigured) {
      setState({
        status: "disabled",
        message: "Account service is not configured on this installation.",
      });
      return;
    }

    setState({ status: "loading", message: "Checking your account…" });

    try {
      const client = getSharedClient();
      clientRef.current = client;
      setSupabase(client);
      const {
        data: { session },
        error,
      } = await client.auth.getSession();
      if (error) throw error;

      const user = session?.user;
      if (!user) {
        setState({
          status: "signed-out",
          message: "Sign in or create an account to play.",
        });
        return;
      }

      if (isAnonymousUser(user)) {
        const { data: profileData } = await client.rpc(
          "get_current_ranked_profile",
        );
        const publicProfile = profileData?.[0];
        setState({
          status: "anonymous",
          user,
          displayName: publicProfile?.display_name ?? null,
          publicProfileId: publicProfile?.public_profile_id ?? null,
          message:
            "Claim this guest account to keep its profile, rating, and match history.",
        });
        return;
      }

      const { data, error: identityError } = await client.rpc(
        "ensure_current_player_identity",
      );
      if (identityError) throw identityError;
      const identity = data?.[0];
      if (!identity?.display_name || !identity.public_profile_id) {
        throw new Error("Incomplete identity");
      }

      setState({
        status: "ready",
        user,
        displayName: identity.display_name,
        publicProfileId: identity.public_profile_id,
        message: null,
      });
    } catch (error) {
      setState({ status: "error", message: friendlyAuthError(error) });
    }
  }, []);

  useEffect(() => {
    const environment = getSupabaseEnvironment();
    if (!environment.isConfigured) {
      const disabledId = window.setTimeout(() => void initialize(), 0);
      return () => window.clearTimeout(disabledId);
    }
    const client = getSharedClient();
    clientRef.current = client;
    const initialLoadId = window.setTimeout(() => void initialize(), 0);
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange(() => {
      window.setTimeout(() => void initialize(), 0);
    });
    return () => {
      window.clearTimeout(initialLoadId);
      subscription.unsubscribe();
    };
  }, [initialize]);

  const signOut = useCallback(async () => {
    if (!clientRef.current) return;
    await clientRef.current.auth.signOut();
    await initialize();
  }, [initialize]);

  return {
    state,
    supabase,
    retry: initialize,
    signOut,
  };
}
