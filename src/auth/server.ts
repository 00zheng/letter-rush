import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { isAnonymousUser, safeNextPath } from "./auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function requirePersistentUser(nextPath: string) {
  const safeNext = safeNextPath(nextPath);
  let user: User | null = null;

  try {
    const supabase = await createServerSupabaseClient();
    const result = await supabase.auth.getUser();
    if (!result.error) user = result.data.user;
  } catch {
    // The login page explains unavailable account configuration.
  }

  if (user && !isAnonymousUser(user)) return user;
  if (user && isAnonymousUser(user)) {
    redirect(`/claim-account?next=${encodeURIComponent(safeNext)}`);
  }
  redirect(`/login?next=${encodeURIComponent(safeNext)}`);
}
