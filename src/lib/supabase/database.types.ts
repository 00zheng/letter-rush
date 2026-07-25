export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          public_profile_id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          public_profile_id: string;
          display_name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          display_name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      matches: {
        Row: {
          id: string;
          room_code: string | null;
          status: Database["public"]["Enums"]["match_status"];
          host_user_id: string | null;
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
          mode: Database["public"]["Enums"]["match_mode"];
          scoring_version: string;
          ranked_ruleset_version: string | null;
          rating_status: Database["public"]["Enums"]["ranked_rating_status"];
          rating_applied_at: string | null;
          mode_key: string;
          rematch_of: string | null;
          preview_started_at: string | null;
          preview_ends_at: string | null;
          reroll_used: boolean;
          reroll_status:
            "idle" | "pending" | "declined" | "approved" | "expired";
          reroll_requested_by: string | null;
          reroll_requested_at: string | null;
          abandoned_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "matches_host_user_id_fkey";
            columns: ["host_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "matches_winner_id_fkey";
            columns: ["winner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      match_players: {
        Row: {
          match_id: string;
          player_user_id: string;
          player_number: number;
          joined_at: string;
          finished_at: string | null;
          validated_score: number | null;
          validated_words: Json;
          result_status: Database["public"]["Enums"]["match_result_status"];
          connection_status:
            "connected" | "disconnected" | "left" | "forfeited";
          last_connected_at: string;
          disconnect_deadline_at: string | null;
          explicitly_left_at: string | null;
          departed_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "match_players_match_id_fkey";
            columns: ["match_id"];
            isOneToOne: false;
            referencedRelation: "matches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "match_players_player_user_id_fkey";
            columns: ["player_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      ranked_stats: {
        Row: {
          user_id: string;
          current_rating: number;
          peak_rating: number;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          forfeits: number;
          best_score: number;
          total_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          created_at: string;
          last_ranked_match_at: string | null;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "ranked_stats_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      rating_history: {
        Row: {
          id: number;
          match_id: string;
          user_id: string;
          opponent_user_id: string;
          rating_before: number;
          rating_delta: number;
          rating_after: number;
          result_status: Database["public"]["Enums"]["match_result_status"];
          validated_score: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ranked_queue: {
        Row: {
          user_id: string;
          status: Database["public"]["Enums"]["ranked_queue_status"];
          rating_snapshot: number;
          joined_at: string;
          heartbeat_at: string;
          match_id: string | null;
          matched_at: string | null;
          cancelled_at: string | null;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      match_reroll_votes: {
        Row: {
          match_id: string;
          user_id: string;
          approve: boolean;
          voted_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ranked_rematch_proposals: {
        Row: {
          id: string;
          source_match_id: string;
          requester_id: string;
          status: Database["public"]["Enums"]["rematch_proposal_status"];
          expires_at: string;
          created_match_id: string | null;
          created_at: string;
          responded_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      two_player_rematch_proposals: {
        Row: {
          id: string;
          source_match_id: string;
          requester_id: string;
          status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
          expires_at: string;
          created_match_id: string | null;
          created_at: string;
          responded_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      private_rematch_invitations: {
        Row: {
          match_id: string;
          invited_user_id: string;
          source_match_id: string;
          accepted_at: string | null;
          declined_at: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      player_mode_stats: {
        Row: {
          user_id: string;
          mode_key: string;
          category: string;
          display_label: string;
          ruleset: Json;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          forfeits: number;
          best_score: number;
          total_score: number;
          total_words: number;
          best_word: string | null;
          best_word_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      player_challenges: {
        Row: {
          id: string;
          challenger_id: string;
          challenged_id: string;
          rated: boolean;
          status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
          expires_at: string;
          created_match_id: string | null;
          created_at: string;
          responded_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      activate_private_match: {
        Args: { p_match_id: string };
        Returns: boolean;
      };
      cancel_private_match: {
        Args: { p_match_id: string };
        Returns: boolean;
      };
      create_private_match: {
        Args: Record<PropertyKey, never>;
        Returns: {
          match_id: string;
          room_code: string;
          board_seed: number;
          round_duration_seconds: number;
          scheduled_start_at: string | null;
          server_now: string;
        }[];
      };
      create_private_lobby: {
        Args: { p_ruleset: Json; p_max_players: number };
        Returns: {
          match_id: string;
          room_code: string;
          board_seed: number;
          round_duration_seconds: number;
          scheduled_start_at: string | null;
          server_now: string;
          max_players: number;
          ruleset: Json;
        }[];
      };
      create_solo_session: {
        Args: { p_ruleset: Json };
        Returns: {
          match_id: string;
          board_seed: number;
          scheduled_start_at: string;
          round_duration_seconds: number;
          ruleset: Json;
          mode_key: string;
          server_now: string;
        }[];
      };
      create_or_resume_solo_session: {
        Args: { p_ruleset: Json };
        Returns: {
          match_id: string;
          board_seed: number;
          scheduled_start_at: string;
          round_duration_seconds: number;
          ruleset: Json;
          mode_key: string;
          server_now: string;
          session_action: "created" | "resumed" | "replaced";
        }[];
      };
      abandon_solo_session: {
        Args: { p_match_id: string };
        Returns: {
          match_id: string;
          round_status: string;
          abandoned: boolean;
          server_now: string;
        }[];
      };
      heartbeat_match_presence: {
        Args: { p_match_id: string };
        Returns: {
          match_status: Database["public"]["Enums"]["match_status"];
          participant_status:
            "connected" | "disconnected" | "left" | "forfeited";
          disconnect_deadline_at: string | null;
          server_now: string;
        }[];
      };
      report_match_disconnect: {
        Args: { p_match_id: string };
        Returns: {
          match_status: Database["public"]["Enums"]["match_status"];
          participant_status:
            "connected" | "disconnected" | "left" | "forfeited";
          disconnect_deadline_at: string | null;
          server_now: string;
        }[];
      };
      reconcile_match_presence: {
        Args: { p_match_id: string };
        Returns: {
          match_status: Database["public"]["Enums"]["match_status"];
          participant_status:
            "connected" | "disconnected" | "left" | "forfeited";
          disconnect_deadline_at: string | null;
          server_now: string;
        }[];
      };
      exit_current_match: {
        Args: { p_match_id: string };
        Returns: {
          match_status: Database["public"]["Enums"]["match_status"];
          participant_status:
            "connected" | "disconnected" | "left" | "forfeited";
          outcome: "abandoned" | "forfeited" | "left" | "already_finalized";
          server_now: string;
        }[];
      };
      vote_match_reroll: {
        Args: { p_match_id: string; p_approve: boolean };
        Returns: {
          reroll_used: boolean;
          approvals: number;
          declines: number;
          participant_count: number;
          board_seed: number;
          preview_ends_at: string;
          server_now: string;
        }[];
      };
      request_ranked_rematch: {
        Args: { p_match_id: string };
        Returns: {
          proposal_id: string;
          proposal_status: Database["public"]["Enums"]["rematch_proposal_status"];
          expires_at: string;
          server_now: string;
        }[];
      };
      respond_ranked_rematch: {
        Args: { p_proposal_id: string; p_accept: boolean };
        Returns: {
          proposal_status: Database["public"]["Enums"]["rematch_proposal_status"];
          match_id: string | null;
          expires_at: string;
          server_now: string;
        }[];
      };
      get_ranked_rematch_state: {
        Args: { p_match_id: string };
        Returns: {
          proposal_id: string;
          proposal_status: Database["public"]["Enums"]["rematch_proposal_status"];
          requested_by_me: boolean;
          can_respond: boolean;
          expires_at: string;
          created_match_id: string | null;
          server_now: string;
        }[];
      };
      request_two_player_rematch: {
        Args: { p_match_id: string };
        Returns: {
          proposal_id: string;
          proposal_status:
            "pending" | "accepted" | "declined" | "expired" | "cancelled";
          requested_by_me: boolean;
          can_respond: boolean;
          expires_at: string;
          created_match_id: string | null;
          server_now: string;
        }[];
      };
      get_two_player_rematch_state: {
        Args: { p_match_id: string };
        Returns: {
          proposal_id: string;
          proposal_status:
            "pending" | "accepted" | "declined" | "expired" | "cancelled";
          requested_by_me: boolean;
          can_respond: boolean;
          expires_at: string;
          created_match_id: string | null;
          server_now: string;
        }[];
      };
      cancel_two_player_rematch: {
        Args: { p_proposal_id: string };
        Returns: {
          proposal_status:
            "pending" | "accepted" | "declined" | "expired" | "cancelled";
          server_now: string;
        }[];
      };
      respond_two_player_rematch: {
        Args: { p_proposal_id: string; p_accept: boolean };
        Returns: {
          proposal_status:
            "pending" | "accepted" | "declined" | "expired" | "cancelled";
          match_id: string | null;
          expires_at: string;
          server_now: string;
        }[];
      };
      create_private_rematch: {
        Args: { p_match_id: string };
        Returns: {
          match_id: string;
          room_code: string;
          board_seed: number;
          max_players: number;
          ruleset: Json;
          server_now: string;
        }[];
      };
      accept_private_rematch_invite: {
        Args: { p_match_id: string };
        Returns: {
          match_id: string;
          room_code: string;
          player_number: number;
          server_now: string;
        }[];
      };
      get_pending_private_rematches: {
        Args: Record<PropertyKey, never>;
        Returns: {
          match_id: string;
          room_code: string;
          source_match_id: string;
          expires_at: string;
          created_at: string;
        }[];
      };
      get_current_mode_stats: {
        Args: { p_category?: string | null; p_page?: number };
        Returns: {
          mode_key: string;
          category: string;
          display_label: string;
          ruleset: Json;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          forfeits: number;
          best_score: number;
          total_score: number;
          total_words: number;
          best_word: string | null;
          best_word_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          updated_at: string;
        }[];
      };
      get_public_mode_leaderboard: {
        Args: { p_mode_key: string; p_page?: number };
        Returns: {
          public_profile_id: string;
          display_name: string;
          mode_key: string;
          category: string;
          games_played: number;
          wins: number;
          ties: number;
          best_score: number;
          total_score: number;
          total_words: number;
          best_word: string | null;
          best_word_score: number;
          competition_rank: number;
          total_players: number;
        }[];
      };
      get_public_player_mode_stats: {
        Args: { p_public_profile_id: string; p_page?: number };
        Returns: {
          mode_key: string;
          category: string;
          display_label: string;
          ruleset: Json;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          best_score: number;
          total_score: number;
          total_words: number;
          best_word: string | null;
          best_word_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          updated_at: string;
        }[];
      };
      finalize_stale_match: {
        Args: { p_match_id: string };
        Returns: boolean;
      };
      get_server_time: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      enter_ranked_queue: {
        Args: Record<PropertyKey, never>;
        Returns: {
          queue_status: Database["public"]["Enums"]["ranked_queue_status"];
          match_id: string | null;
          joined_at: string;
          heartbeat_at: string;
          rating_snapshot: number;
          server_now: string;
        }[];
      };
      ensure_current_player_identity: {
        Args: Record<PropertyKey, never>;
        Returns: {
          display_name: string;
          public_profile_id: string;
        }[];
      };
      create_player_challenge: {
        Args: { p_public_profile_id: string; p_rated: boolean };
        Returns: {
          challenge_id: string;
          direction: "incoming" | "outgoing";
          opponent_public_profile_id: string;
          opponent_display_name: string;
          rated: boolean;
          challenge_status:
            "pending" | "accepted" | "declined" | "cancelled" | "expired";
          expires_at: string;
          match_id: string | null;
          match_mode: Database["public"]["Enums"]["match_mode"] | null;
          room_code: string | null;
          server_now: string;
        }[];
      };
      get_current_player_challenges: {
        Args: Record<PropertyKey, never>;
        Returns: {
          challenge_id: string;
          direction: "incoming" | "outgoing";
          opponent_public_profile_id: string;
          opponent_display_name: string;
          rated: boolean;
          challenge_status:
            "pending" | "accepted" | "declined" | "cancelled" | "expired";
          expires_at: string;
          match_id: string | null;
          match_mode: Database["public"]["Enums"]["match_mode"] | null;
          room_code: string | null;
          server_now: string;
        }[];
      };
      respond_player_challenge: {
        Args: { p_challenge_id: string; p_accept: boolean };
        Returns: {
          challenge_status:
            "pending" | "accepted" | "declined" | "cancelled" | "expired";
          match_id: string | null;
          match_mode: Database["public"]["Enums"]["match_mode"] | null;
          room_code: string | null;
          server_now: string;
        }[];
      };
      cancel_player_challenge: {
        Args: { p_challenge_id: string };
        Returns: boolean;
      };
      get_match_word_opportunities: {
        Args: { p_match_id: string };
        Returns: {
          word: string;
          word_length: number;
          score: number;
          recognizable: boolean;
          was_found: boolean;
        }[];
      };
      heartbeat_ranked_queue: {
        Args: Record<PropertyKey, never>;
        Returns: {
          queue_status: Database["public"]["Enums"]["ranked_queue_status"];
          match_id: string | null;
          joined_at: string;
          heartbeat_at: string;
          rating_snapshot: number;
          server_now: string;
        }[];
      };
      get_ranked_queue_state: {
        Args: Record<PropertyKey, never>;
        Returns: {
          queue_status: Database["public"]["Enums"]["ranked_queue_status"];
          match_id: string | null;
          joined_at: string;
          heartbeat_at: string;
          rating_snapshot: number;
          server_now: string;
        }[];
      };
      cancel_ranked_queue: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      get_current_ranked_profile: {
        Args: Record<PropertyKey, never>;
        Returns: {
          public_profile_id: string;
          display_name: string;
          current_rating: number;
          peak_rating: number;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          forfeits: number;
          best_score: number;
          total_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          ranked_since: string;
        }[];
      };
      get_public_player_profile: {
        Args: { p_public_profile_id: string };
        Returns: {
          public_profile_id: string;
          display_name: string;
          current_rating: number;
          peak_rating: number;
          games_played: number;
          wins: number;
          losses: number;
          ties: number;
          forfeits: number;
          best_score: number;
          total_score: number;
          current_win_streak: number;
          best_win_streak: number;
          current_unbeaten_streak: number;
          ranked_since: string;
          rating_rank: number | null;
        }[];
      };
      get_ranked_leaderboard: {
        Args: { p_category: string; p_page?: number };
        Returns: {
          public_profile_id: string;
          display_name: string;
          current_rating: number;
          peak_rating: number;
          games_played: number;
          wins: number;
          best_score: number;
          metric_value: number;
          competition_rank: number;
          total_players: number;
        }[];
      };
      get_current_ranked_placement: {
        Args: { p_category: string };
        Returns: {
          public_profile_id: string;
          metric_value: number;
          competition_rank: number;
          total_players: number;
        }[];
      };
      get_public_ranked_matches: {
        Args: { p_public_profile_id: string; p_limit?: number };
        Returns: {
          match_public_id: string;
          completed_at: string;
          player_score: number;
          opponent_public_profile_id: string;
          opponent_display_name: string;
          opponent_score: number;
          result_status: Database["public"]["Enums"]["match_result_status"];
          rating_before: number;
          rating_delta: number;
          rating_after: number;
        }[];
      };
      get_ranked_match_result: {
        Args: { p_match_id: string };
        Returns: {
          public_profile_id: string;
          display_name: string;
          player_number: number;
          validated_score: number | null;
          validated_words: Json;
          result_status: Database["public"]["Enums"]["match_result_status"];
          rating_before: number | null;
          rating_delta: number | null;
          rating_after: number | null;
          match_status: Database["public"]["Enums"]["match_status"];
          rating_status: Database["public"]["Enums"]["ranked_rating_status"];
          completed_at: string | null;
          server_now: string;
        }[];
      };
      join_private_match: {
        Args: { p_room_code: string };
        Returns: {
          match_id: string;
          room_code: string;
          status: Database["public"]["Enums"]["match_status"];
          board_seed: number;
          round_duration_seconds: number;
          scheduled_start_at: string;
          server_now: string;
          max_players: number;
          ruleset: Json;
        }[];
      };
      leave_private_match: {
        Args: { p_match_id: string };
        Returns: boolean;
      };
      start_private_match: {
        Args: { p_match_id: string };
        Returns: string;
      };
      update_private_match_rules: {
        Args: {
          p_match_id: string;
          p_ruleset: Json;
          p_max_players: number;
        };
        Returns: Json;
      };
      submit_match_result: {
        Args: { p_match_id: string; p_submissions: Json };
        Returns: {
          validated_score: number;
          already_finalized: boolean;
          match_completed: boolean;
        }[];
      };
    };
    Enums: {
      match_status:
        "waiting" | "starting" | "active" | "completed" | "cancelled";
      match_result_status: "pending" | "winner" | "loser" | "tie" | "forfeit";
      match_mode: "private" | "ranked" | "solo";
      ranked_rating_status:
        "not_applicable" | "pending" | "applied" | "abandoned";
      ranked_queue_status: "waiting" | "matched" | "cancelled" | "completed";
      rematch_proposal_status: "pending" | "accepted" | "declined" | "expired";
    };
    CompositeTypes: Record<string, never>;
  };
};
