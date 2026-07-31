"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useSyncExternalStore } from "react";

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

const serverAuthState: PlayerAuthState = {
  status: "loading",
  message: "Loading player…",
};

let sharedBrowserClient: BrowserSupabaseClient | null = null;
let sharedAuthState: PlayerAuthState = serverAuthState;
let initialization: Promise<void> | null = null;
let authStoreStarted = false;
const authListeners = new Set<() => void>();

function getSharedClient(): BrowserSupabaseClient {
  sharedBrowserClient ??= createBrowserSupabaseClient();
  return sharedBrowserClient;
}

function publishAuthState(nextState: PlayerAuthState) {
  sharedAuthState = nextState;
  authListeners.forEach((listener) => listener());
}

function subscribeToAuthState(listener: () => void) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function initializePlayerAuth(showLoading = false) {
  if (showLoading) {
    publishAuthState({
      status: "loading",
      message: "Loading player…",
    });
  }
  if (initialization) return initialization;

  initialization = (async () => {
    const environment = getSupabaseEnvironment();
    if (!environment.isConfigured) {
      publishAuthState({
        status: "disabled",
        message: "Account service is not configured on this installation.",
      });
      return;
    }

    try {
      const client = getSharedClient();
      const {
        data: { session },
        error,
      } = await client.auth.getSession();
      if (error) throw error;

      const user = session?.user;
      if (!user) {
        publishAuthState({
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
        publishAuthState({
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

      publishAuthState({
        status: "ready",
        user,
        displayName: identity.display_name,
        publicProfileId: identity.public_profile_id,
        message: null,
      });
    } catch (error) {
      publishAuthState({
        status: "error",
        message: friendlyAuthError(error),
      });
    }
  })().finally(() => {
    initialization = null;
  });

  return initialization;
}

function startAuthStore() {
  if (authStoreStarted) return;
  authStoreStarted = true;

  const environment = getSupabaseEnvironment();
  if (!environment.isConfigured) {
    void initializePlayerAuth();
    return;
  }

  const client = getSharedClient();
  client.auth.onAuthStateChange((event) => {
    // Token refreshes are background maintenance. The current player is still
    // valid, so keep the settled UI instead of flashing a loading screen.
    if (event === "TOKEN_REFRESHED") return;
    if (event === "SIGNED_OUT") {
      publishAuthState({
        status: "signed-out",
        message: "Sign in or create an account to play.",
      });
      return;
    }

    window.setTimeout(() => void initializePlayerAuth(), 0);
  });
  void initializePlayerAuth();
}

export function usePlayerAuth() {
  const state = useSyncExternalStore(
    subscribeToAuthState,
    () => sharedAuthState,
    () => serverAuthState,
  );

  useEffect(() => {
    startAuthStore();
  }, []);

  const retry = useCallback(() => initializePlayerAuth(true), []);

  const signOut = useCallback(async () => {
    const environment = getSupabaseEnvironment();
    if (!environment.isConfigured) return;

    const { error } = await getSharedClient().auth.signOut();
    if (error) {
      publishAuthState({
        status: "error",
        message: friendlyAuthError(error),
      });
      return;
    }
    publishAuthState({
      status: "signed-out",
      message: "Sign in or create an account to play.",
    });
  }, []);

  return {
    state,
    supabase: sharedBrowserClient,
    retry,
    signOut,
  };
}
