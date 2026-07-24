import type { Database } from "@/lib/supabase/database.types";

export type RankedQueueState =
  Database["public"]["Functions"]["get_ranked_queue_state"]["Returns"][number];
export type RankedProfile =
  Database["public"]["Functions"]["get_current_ranked_profile"]["Returns"][number];
export type PublicRankedProfile =
  Database["public"]["Functions"]["get_public_player_profile"]["Returns"][number];
export type LeaderboardEntry =
  Database["public"]["Functions"]["get_ranked_leaderboard"]["Returns"][number];
export type RankedPlacement =
  Database["public"]["Functions"]["get_current_ranked_placement"]["Returns"][number];
export type PublicRankedMatch =
  Database["public"]["Functions"]["get_public_ranked_matches"]["Returns"][number];
export type RankedMatchResult =
  Database["public"]["Functions"]["get_ranked_match_result"]["Returns"][number];
