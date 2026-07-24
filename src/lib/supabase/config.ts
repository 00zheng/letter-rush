export const REQUIRED_SUPABASE_ENVIRONMENT_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;

export type SupabaseEnvironment =
  | {
      isConfigured: true;
      url: string;
      publishableKey: string;
      missing: [];
    }
  | {
      isConfigured: false;
      url: null;
      publishableKey: null;
      missing: string[];
    };

export function getSupabaseEnvironment(): SupabaseEnvironment {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const missing: string[] = [];

  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }

  if (!url || !publishableKey) {
    return {
      isConfigured: false,
      url: null,
      publishableKey: null,
      missing,
    };
  }

  return {
    isConfigured: true,
    url,
    publishableKey,
    missing: [],
  };
}

export function requireSupabaseEnvironment(): {
  url: string;
  publishableKey: string;
} {
  const environment = getSupabaseEnvironment();

  if (!environment.isConfigured) {
    throw new Error(
      `Supabase multiplayer is not configured. Add ${environment.missing.join(
        " and ",
      )} to .env.local.`,
    );
  }

  return environment;
}
