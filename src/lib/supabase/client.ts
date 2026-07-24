import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./database.types";
import { requireSupabaseEnvironment } from "./config";

export function createBrowserSupabaseClient() {
  const { url, publishableKey } = requireSupabaseEnvironment();

  return createBrowserClient<Database>(url, publishableKey);
}

export type BrowserSupabaseClient = ReturnType<
  typeof createBrowserSupabaseClient
>;
