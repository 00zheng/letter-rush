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
          display_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
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
          room_code: string;
          status: Database["public"]["Enums"]["match_status"];
          host_user_id: string;
          board_seed: number;
          round_duration_seconds: number;
          scheduled_start_at: string | null;
          created_at: string;
          completed_at: string | null;
          winner_id: string | null;
          is_tie: boolean;
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
      finalize_stale_match: {
        Args: { p_match_id: string };
        Returns: boolean;
      };
      get_server_time: {
        Args: Record<PropertyKey, never>;
        Returns: string;
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
        }[];
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
    };
    CompositeTypes: Record<string, never>;
  };
};
