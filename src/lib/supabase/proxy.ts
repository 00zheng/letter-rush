import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { getSupabaseEnvironment } from "./config";
import type { Database } from "./database.types";

export async function updateSupabaseSession(request: NextRequest) {
  const environment = getSupabaseEnvironment();

  if (!environment.isConfigured) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(
    environment.url,
    environment.publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          response = NextResponse.next({ request });

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });

          Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        },
      },
    },
  );

  try {
    // getClaims validates and refreshes the cookie-backed JWT. Authorization is
    // still rechecked in every Route Handler and database policy/RPC.
    await supabase.auth.getClaims();
  } catch {
    // A temporary Supabase outage must not make local single-player unusable.
  }

  return response;
}
