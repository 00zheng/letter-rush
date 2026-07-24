import type { Json } from "@/lib/supabase/database.types";

export type MatchStatus =
  "waiting" | "starting" | "active" | "completed" | "cancelled";

export type MatchResultStatus =
  "pending" | "winner" | "loser" | "tie" | "forfeit";

export type MatchRecord = {
  id: string;
  room_code: string;
  status: MatchStatus;
  host_user_id: string;
  board_seed: number;
  round_duration_seconds: number;
  scheduled_start_at: string | null;
  created_at: string;
  completed_at: string | null;
  winner_id: string | null;
  is_tie: boolean;
  max_players: number;
  ruleset: Json;
  dictionary_version: string;
  board_generation_version: string;
  ruleset_version: string;
};

export type MatchPlayerRecord = {
  match_id: string;
  player_user_id: string;
  player_number: number;
  joined_at: string;
  finished_at: string | null;
  validated_score: number | null;
  validated_words: Json;
  result_status: MatchResultStatus;
};

export type RoomParticipant = MatchPlayerRecord & {
  displayName: string;
};

export type PrivateRoomState = {
  match: MatchRecord;
  players: RoomParticipant[];
  serverNow: string;
};

export type CreatePrivateMatchResponse = {
  match_id: string;
  room_code: string;
  board_seed: number;
  round_duration_seconds: number;
  scheduled_start_at: string | null;
  server_now: string;
  max_players: number;
  ruleset: Json;
};

export type JoinPrivateMatchResponse = CreatePrivateMatchResponse & {
  status: MatchStatus;
};

export type SubmitMatchResultResponse = {
  validated_score: number;
  already_finalized: boolean;
  match_completed: boolean;
};
