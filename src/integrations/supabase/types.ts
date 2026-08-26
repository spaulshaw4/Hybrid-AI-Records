export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      application_drafts: {
        Row: {
          ack: boolean
          artist: string
          created_at: string
          email: string
          id: string
          link: string
          notes: string
          pkg: string
          saved_at: string
          scope: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ack?: boolean
          artist?: string
          created_at?: string
          email?: string
          id?: string
          link?: string
          notes?: string
          pkg?: string
          saved_at?: string
          scope: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ack?: boolean
          artist?: string
          created_at?: string
          email?: string
          id?: string
          link?: string
          notes?: string
          pkg?: string
          saved_at?: string
          scope?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      artist_token_balances: {
        Row: {
          balance: number
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      artist_token_ledger: {
        Row: {
          balance_after: number | null
          created_at: string
          delta: number
          id: string
          kind: string
          note: string | null
          reference: string | null
          user_id: string
        }
        Insert: {
          balance_after?: number | null
          created_at?: string
          delta: number
          id?: string
          kind: string
          note?: string | null
          reference?: string | null
          user_id: string
        }
        Update: {
          balance_after?: number | null
          created_at?: string
          delta?: number
          id?: string
          kind?: string
          note?: string | null
          reference?: string | null
          user_id?: string
        }
        Relationships: []
      }
      artist_token_purchases: {
        Row: {
          amount_total: number | null
          created_at: string
          currency: string | null
          id: string
          price_id: string
          stripe_session_id: string
          tokens: number
          user_id: string
        }
        Insert: {
          amount_total?: number | null
          created_at?: string
          currency?: string | null
          id?: string
          price_id: string
          stripe_session_id: string
          tokens: number
          user_id: string
        }
        Update: {
          amount_total?: number | null
          created_at?: string
          currency?: string | null
          id?: string
          price_id?: string
          stripe_session_id?: string
          tokens?: number
          user_id?: string
        }
        Relationships: []
      }
      artist_track_downloads: {
        Row: {
          created_at: string
          id: string
          track_artist: string | null
          track_id: string
          track_title: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          track_artist?: string | null
          track_id: string
          track_title?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          track_artist?: string | null
          track_id?: string
          track_title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      artist_tracks: {
        Row: {
          album_id: string
          album_title: string
          artist_name: string
          audio_url: string
          cover_url: string | null
          created_at: string
          credits: string | null
          division: string | null
          genre: string | null
          id: string
          price_tokens: number
          radio_ready: boolean
          storage_path: string
          title: string
          track_number: number
          track_total: number | null
          updated_at: string
        }
        Insert: {
          album_id: string
          album_title: string
          artist_name?: string
          audio_url: string
          cover_url?: string | null
          created_at?: string
          credits?: string | null
          division?: string | null
          genre?: string | null
          id: string
          price_tokens?: number
          radio_ready?: boolean
          storage_path: string
          title: string
          track_number: number
          track_total?: number | null
          updated_at?: string
        }
        Update: {
          album_id?: string
          album_title?: string
          artist_name?: string
          audio_url?: string
          cover_url?: string | null
          created_at?: string
          credits?: string | null
          division?: string | null
          genre?: string | null
          id?: string
          price_tokens?: number
          radio_ready?: boolean
          storage_path?: string
          title?: string
          track_number?: number
          track_total?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      engine_proxy_cache: {
        Row: {
          created_at: string
          expires_at: string
          fingerprint: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          expires_at: string
          fingerprint: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          expires_at?: string
          fingerprint?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      form_drafts: {
        Row: {
          created_at: string
          email: string
          id: string
          owner_key_hash: string | null
          payload: Json
          resume_token_hash: string | null
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          owner_key_hash?: string | null
          payload?: Json
          resume_token_hash?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          owner_key_hash?: string | null
          payload?: Json
          resume_token_hash?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      funnel_events: {
        Row: {
          created_at: string
          currency: string | null
          details: Json
          event: string
          id: string
          mode: string | null
          package_slug: string | null
          reference: string | null
          step: string | null
          step_index: number | null
          visitor_session: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          details?: Json
          event: string
          id?: string
          mode?: string | null
          package_slug?: string | null
          reference?: string | null
          step?: string | null
          step_index?: number | null
          visitor_session: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          details?: Json
          event?: string
          id?: string
          mode?: string | null
          package_slug?: string | null
          reference?: string | null
          step?: string | null
          step_index?: number | null
          visitor_session?: string
        }
        Relationships: []
      }
      fx_rates: {
        Row: {
          currency: string
          fetched_at: string
          rate: number
          source: string
          updated_at: string
        }
        Insert: {
          currency: string
          fetched_at?: string
          rate: number
          source?: string
          updated_at?: string
        }
        Update: {
          currency?: string
          fetched_at?: string
          rate?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      generation_tasks: {
        Row: {
          audio_url: string | null
          created_at: string
          id: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          audio_url?: string | null
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          audio_url?: string | null
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      index_coverage_snapshots: {
        Row: {
          captured_at: string
          id: string
          indexed_count: number
          not_indexed_count: number
          pages: Json
          site_url: string
          sitemap_indexed: number
          sitemap_submitted: number
          sitemap_total: number
          unknown_count: number
        }
        Insert: {
          captured_at?: string
          id?: string
          indexed_count?: number
          not_indexed_count?: number
          pages?: Json
          site_url: string
          sitemap_indexed?: number
          sitemap_submitted?: number
          sitemap_total?: number
          unknown_count?: number
        }
        Update: {
          captured_at?: string
          id?: string
          indexed_count?: number
          not_indexed_count?: number
          pages?: Json
          site_url?: string
          sitemap_indexed?: number
          sitemap_submitted?: number
          sitemap_total?: number
          unknown_count?: number
        }
        Relationships: []
      }
      lyrics_submissions: {
        Row: {
          artist: string
          created_at: string
          email: string
          file_name: string | null
          file_path: string | null
          id: string
          language: string
          lyrics_text: string | null
          notes: string | null
          package_label: string | null
          package_slug: string | null
          status: string
          updated_at: string
        }
        Insert: {
          artist: string
          created_at?: string
          email: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          language: string
          lyrics_text?: string | null
          notes?: string | null
          package_label?: string | null
          package_slug?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          artist?: string
          created_at?: string
          email?: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          language?: string
          lyrics_text?: string | null
          notes?: string | null
          package_label?: string | null
          package_slug?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      pricing_access_alerts: {
        Row: {
          actor_role: string
          actor_user_id: string | null
          created_at: string
          detail: string | null
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrences: number
          outcome: string
          source: string
          updated_at: string
        }
        Insert: {
          actor_role: string
          actor_user_id?: string | null
          created_at?: string
          detail?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          outcome: string
          source: string
          updated_at?: string
        }
        Update: {
          actor_role?: string
          actor_user_id?: string | null
          created_at?: string
          detail?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          outcome?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      pricing_settings: {
        Row: {
          created_at: string
          key: string
          surcharge_bps: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          key: string
          surcharge_bps?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          key?: string
          surcharge_bps?: Json
          updated_at?: string
        }
        Relationships: []
      }
      pricing_settings_audit: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          preferences: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          preferences?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          preferences?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      radio_settings: {
        Row: {
          created_at: string
          mix_seed: number
          mix_style: string
          positions: Json
          queue: Json
          shuffle: boolean
          spacing: number
          track_key: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          mix_seed?: number
          mix_style?: string
          positions?: Json
          queue?: Json
          shuffle?: boolean
          spacing?: number
          track_key?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          mix_seed?: number
          mix_style?: string
          positions?: Json
          queue?: Json
          shuffle?: boolean
          spacing?: number
          track_key?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      session_email_log: {
        Row: {
          created_at: string
          id: string
          kind: string
          outcome: string
          reason: string | null
          recipient: string
          request_id: string
          slot: Json | null
          subject: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          outcome?: string
          reason?: string | null
          recipient: string
          request_id: string
          slot?: Json | null
          subject: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          outcome?: string
          reason?: string | null
          recipient?: string
          request_id?: string
          slot?: Json | null
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_email_log_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "vocal_session_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      studio_requests: {
        Row: {
          artist: string
          brief: string
          created_at: string
          delivered_at: string | null
          delivery_note: string | null
          delivery_path: string | null
          delivery_url: string | null
          email: string
          id: string
          instrumental: boolean
          reference: string
          status: string
          style: string
          title: string
          updated_at: string
        }
        Insert: {
          artist: string
          brief?: string
          created_at?: string
          delivered_at?: string | null
          delivery_note?: string | null
          delivery_path?: string | null
          delivery_url?: string | null
          email: string
          id?: string
          instrumental?: boolean
          reference: string
          status?: string
          style?: string
          title?: string
          updated_at?: string
        }
        Update: {
          artist?: string
          brief?: string
          created_at?: string
          delivered_at?: string | null
          delivery_note?: string | null
          delivery_path?: string | null
          delivery_url?: string | null
          email?: string
          id?: string
          instrumental?: boolean
          reference?: string
          status?: string
          style?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      studio_tracks: {
        Row: {
          audio_url: string | null
          created_at: string
          error_message: string | null
          id: string
          mastered_status: string
          prompt: string | null
          storage_path: string | null
          style: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          audio_url?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          mastered_status?: string
          prompt?: string | null
          storage_path?: string | null
          style?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          audio_url?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          mastered_status?: string
          prompt?: string | null
          storage_path?: string | null
          style?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      support_error_reports: {
        Row: {
          created_at: string
          email_opened_at: string | null
          email_status: string
          id: string
          message: string | null
          occurrences: number
          params: Json
          pathname: string
          reference: string
          route_id: string
          search: Json
          source: string
          stage: string
          updated_at: string
          url: string | null
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          email_opened_at?: string | null
          email_status?: string
          id?: string
          message?: string | null
          occurrences?: number
          params?: Json
          pathname?: string
          reference: string
          route_id?: string
          search?: Json
          source?: string
          stage?: string
          updated_at?: string
          url?: string | null
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          email_opened_at?: string | null
          email_status?: string
          id?: string
          message?: string | null
          occurrences?: number
          params?: Json
          pathname?: string
          reference?: string
          route_id?: string
          search?: Json
          source?: string
          stage?: string
          updated_at?: string
          url?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      token_audit_log: {
        Row: {
          admin_id: string | null
          balance_after: number | null
          created_at: string
          id: string
          reason: string | null
          token_amount: number
          user_id: string
        }
        Insert: {
          admin_id?: string | null
          balance_after?: number | null
          created_at?: string
          id?: string
          reason?: string | null
          token_amount: number
          user_id: string
        }
        Update: {
          admin_id?: string | null
          balance_after?: number | null
          created_at?: string
          id?: string
          reason?: string | null
          token_amount?: number
          user_id?: string
        }
        Relationships: []
      }
      token_balances: {
        Row: {
          balance: number
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      token_ledger: {
        Row: {
          balance_after: number | null
          created_at: string
          delta: number
          id: string
          idempotency_key: string | null
          kind: string
          note: string | null
          reference: string | null
          user_id: string
        }
        Insert: {
          balance_after?: number | null
          created_at?: string
          delta: number
          id?: string
          idempotency_key?: string | null
          kind: string
          note?: string | null
          reference?: string | null
          user_id: string
        }
        Update: {
          balance_after?: number | null
          created_at?: string
          delta?: number
          id?: string
          idempotency_key?: string | null
          kind?: string
          note?: string | null
          reference?: string | null
          user_id?: string
        }
        Relationships: []
      }
      token_purchases: {
        Row: {
          amount_total: number | null
          created_at: string
          currency: string | null
          id: string
          price_id: string
          stripe_session_id: string
          tokens: number
          user_id: string
        }
        Insert: {
          amount_total?: number | null
          created_at?: string
          currency?: string | null
          id?: string
          price_id: string
          stripe_session_id: string
          tokens: number
          user_id: string
        }
        Update: {
          amount_total?: number | null
          created_at?: string
          currency?: string | null
          id?: string
          price_id?: string
          stripe_session_id?: string
          tokens?: number
          user_id?: string
        }
        Relationships: []
      }
      track_requests: {
        Row: {
          acknowledged: boolean
          artist: string
          artist_note: string | null
          created_at: string
          email: string
          file_name: string | null
          flag_details: string | null
          flag_resolution_note: string | null
          flag_resolved_at: string | null
          flag_resolved_by: string | null
          flagged_at: string | null
          id: string
          last_payment_attempt_at: string | null
          last_payment_error: string | null
          last_payment_session_id: string | null
          link: string | null
          locked_delivery_earliest: string | null
          locked_delivery_latest: string | null
          locked_tier: string | null
          locked_turnaround_label: string | null
          notes: string | null
          package_label: string
          paid_amount_label: string | null
          paid_at: string | null
          paid_session_id: string | null
          payment_currency: string | null
          payment_state: string
          reference_code: string
          review_flag: string | null
          review_started_at: string | null
          revision_request: string | null
          revision_round: number
          revision_updated_at: string | null
          status: string
          status_note: string | null
          tier_locked_at: string | null
          updated_at: string
        }
        Insert: {
          acknowledged?: boolean
          artist: string
          artist_note?: string | null
          created_at?: string
          email: string
          file_name?: string | null
          flag_details?: string | null
          flag_resolution_note?: string | null
          flag_resolved_at?: string | null
          flag_resolved_by?: string | null
          flagged_at?: string | null
          id?: string
          last_payment_attempt_at?: string | null
          last_payment_error?: string | null
          last_payment_session_id?: string | null
          link?: string | null
          locked_delivery_earliest?: string | null
          locked_delivery_latest?: string | null
          locked_tier?: string | null
          locked_turnaround_label?: string | null
          notes?: string | null
          package_label: string
          paid_amount_label?: string | null
          paid_at?: string | null
          paid_session_id?: string | null
          payment_currency?: string | null
          payment_state?: string
          reference_code: string
          review_flag?: string | null
          review_started_at?: string | null
          revision_request?: string | null
          revision_round?: number
          revision_updated_at?: string | null
          status?: string
          status_note?: string | null
          tier_locked_at?: string | null
          updated_at?: string
        }
        Update: {
          acknowledged?: boolean
          artist?: string
          artist_note?: string | null
          created_at?: string
          email?: string
          file_name?: string | null
          flag_details?: string | null
          flag_resolution_note?: string | null
          flag_resolved_at?: string | null
          flag_resolved_by?: string | null
          flagged_at?: string | null
          id?: string
          last_payment_attempt_at?: string | null
          last_payment_error?: string | null
          last_payment_session_id?: string | null
          link?: string | null
          locked_delivery_earliest?: string | null
          locked_delivery_latest?: string | null
          locked_tier?: string | null
          locked_turnaround_label?: string | null
          notes?: string | null
          package_label?: string
          paid_amount_label?: string | null
          paid_at?: string | null
          paid_session_id?: string | null
          payment_currency?: string | null
          payment_state?: string
          reference_code?: string
          review_flag?: string | null
          review_started_at?: string | null
          revision_request?: string | null
          revision_round?: number
          revision_updated_at?: string | null
          status?: string
          status_note?: string | null
          tier_locked_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tracks: {
        Row: {
          created_at: string
          genre_prompt: string | null
          id: string
          instrumental_url: string | null
          intro_url: string | null
          lyrics: string | null
          master_url: string | null
          title: string
          user_id: string
          vocal_url: string | null
        }
        Insert: {
          created_at?: string
          genre_prompt?: string | null
          id?: string
          instrumental_url?: string | null
          intro_url?: string | null
          lyrics?: string | null
          master_url?: string | null
          title: string
          user_id: string
          vocal_url?: string | null
        }
        Update: {
          created_at?: string
          genre_prompt?: string | null
          id?: string
          instrumental_url?: string | null
          intro_url?: string | null
          lyrics?: string | null
          master_url?: string | null
          title?: string
          user_id?: string
          vocal_url?: string | null
        }
        Relationships: []
      }
      translation_overrides: {
        Row: {
          created_at: string
          id: string
          language: string
          source_text: string
          translated_text: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          language: string
          source_text: string
          translated_text: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          language?: string
          source_text?: string
          translated_text?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      upload_audit_log: {
        Row: {
          action: string
          bucket: string
          created_at: string
          details: Json
          error_message: string | null
          file_name: string | null
          file_size: number | null
          id: string
          object_path: string
          outcome: string
          reference_code: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          bucket?: string
          created_at?: string
          details?: Json
          error_message?: string | null
          file_name?: string | null
          file_size?: number | null
          id?: string
          object_path: string
          outcome?: string
          reference_code?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          bucket?: string
          created_at?: string
          details?: Json
          error_message?: string | null
          file_name?: string | null
          file_size?: number | null
          id?: string
          object_path?: string
          outcome?: string
          reference_code?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_vault: {
        Row: {
          album_id: string | null
          album_name: string | null
          artist_id: string | null
          artist_name: string | null
          created_at: string
          id: string
          instrumental_url: string | null
          master_url: string | null
          provider_task_id: string | null
          raw_audio_url: string | null
          status: string
          style: string | null
          title: string
          tokens_used: number
          user_id: string | null
          vocal_url: string | null
        }
        Insert: {
          album_id?: string | null
          album_name?: string | null
          artist_id?: string | null
          artist_name?: string | null
          created_at?: string
          id?: string
          instrumental_url?: string | null
          master_url?: string | null
          provider_task_id?: string | null
          raw_audio_url?: string | null
          status?: string
          style?: string | null
          title?: string
          tokens_used?: number
          user_id?: string | null
          vocal_url?: string | null
        }
        Update: {
          album_id?: string | null
          album_name?: string | null
          artist_id?: string | null
          artist_name?: string | null
          created_at?: string
          id?: string
          instrumental_url?: string | null
          master_url?: string | null
          provider_task_id?: string | null
          raw_audio_url?: string | null
          status?: string
          style?: string | null
          title?: string
          tokens_used?: number
          user_id?: string | null
          vocal_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_vault_album_id_fkey"
            columns: ["album_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_vault_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
        ]
      }
      artists: {
        Row: {
          created_at: string
          id: string
          name: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      albums: {
        Row: {
          artist_id: string | null
          cover_url: string | null
          created_at: string
          id: string
          name: string
          user_id: string | null
        }
        Insert: {
          artist_id?: string | null
          cover_url?: string | null
          created_at?: string
          id?: string
          name: string
          user_id?: string | null
        }
        Update: {
          artist_id?: string | null
          cover_url?: string | null
          created_at?: string
          id?: string
          name?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "albums_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notifications: {
        Row: {
          body: string
          created_at: string
          emailed: boolean
          id: string
          kind: string
          read_at: string | null
          reference: string | null
          title: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          emailed?: boolean
          id?: string
          kind: string
          read_at?: string | null
          reference?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          emailed?: boolean
          id?: string
          kind?: string
          read_at?: string | null
          reference?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      v_token_balances: {
        Row: {
          balance: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      v_token_ledger: {
        Row: {
          balance_after: number | null
          created_at: string
          delta: number
          id: string
          kind: string
          note: string | null
          reference: string | null
          user_id: string
        }
        Insert: {
          balance_after?: number | null
          created_at?: string
          delta: number
          id?: string
          kind: string
          note?: string | null
          reference?: string | null
          user_id: string
        }
        Update: {
          balance_after?: number | null
          created_at?: string
          delta?: number
          id?: string
          kind?: string
          note?: string | null
          reference?: string | null
          user_id?: string
        }
        Relationships: []
      }
      vocal_session_requests: {
        Row: {
          artist: string
          confirmed_at: string | null
          confirmed_slot: Json | null
          created_at: string
          email: string
          id: string
          meeting_link: string | null
          meeting_room: string | null
          notes: string | null
          original_request_id: string | null
          package_label: string | null
          package_slug: string | null
          reschedule_round: number
          slots: Json
          status: string
          timezone: string
          timezone_offset_minutes: number | null
          updated_at: string
        }
        Insert: {
          artist: string
          confirmed_at?: string | null
          confirmed_slot?: Json | null
          created_at?: string
          email: string
          id?: string
          meeting_link?: string | null
          meeting_room?: string | null
          notes?: string | null
          original_request_id?: string | null
          package_label?: string | null
          package_slug?: string | null
          reschedule_round?: number
          slots?: Json
          status?: string
          timezone: string
          timezone_offset_minutes?: number | null
          updated_at?: string
        }
        Update: {
          artist?: string
          confirmed_at?: string | null
          confirmed_slot?: Json | null
          created_at?: string
          email?: string
          id?: string
          meeting_link?: string | null
          meeting_room?: string | null
          notes?: string | null
          original_request_id?: string | null
          package_label?: string | null
          package_slug?: string | null
          reschedule_round?: number
          slots?: Json
          status?: string
          timezone?: string
          timezone_offset_minutes?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vocal_session_requests_original_request_id_fkey"
            columns: ["original_request_id"]
            isOneToOne: false
            referencedRelation: "vocal_session_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_profiles: {
        Row: {
          clip_bars: number | null
          clip_ratio: number | null
          created_at: string
          id: string
          label: string
          peak: number | null
          quality_blocked: boolean | null
          rms: number | null
          sample_url: string
          silence_bars: number | null
          silence_ratio: number | null
          total_bars: number | null
          trim_start_seconds: number | null
          user_id: string
          voice_id: string
        }
        Insert: {
          clip_bars?: number | null
          clip_ratio?: number | null
          created_at?: string
          id?: string
          label: string
          peak?: number | null
          quality_blocked?: boolean | null
          rms?: number | null
          sample_url: string
          silence_bars?: number | null
          silence_ratio?: number | null
          total_bars?: number | null
          trim_start_seconds?: number | null
          user_id: string
          voice_id: string
        }
        Update: {
          clip_bars?: number | null
          clip_ratio?: number | null
          created_at?: string
          id?: string
          label?: string
          peak?: number | null
          quality_blocked?: boolean | null
          rms?: number | null
          sample_url?: string
          silence_bars?: number | null
          silence_ratio?: number | null
          total_bars?: number | null
          trim_start_seconds?: number | null
          user_id?: string
          voice_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      pricing_settings_public: {
        Row: {
          created_at: string | null
          key: string | null
          surcharge_bps: Json | null
          updated_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_list_token_audit: {
        Args: {
          acting_admin_id?: string
          email_filter?: string
          from_date?: string
          max_amount?: number
          min_amount?: number
          reason_filter?: string
          row_limit?: number
          to_date?: string
        }
        Returns: {
          admin_email: string
          balance_after: number
          created_at: string
          email: string
          id: string
          reason: string
          token_amount: number
          user_id: string
        }[]
      }
      admin_lookup_token_user: {
        Args: { acting_admin_id?: string; target_email: string }
        Returns: {
          balance: number
          email: string
          user_id: string
        }[]
      }
      credit_artist_token_purchase: {
        Args: {
          _amount_total: number
          _currency: string
          _price_id: string
          _session_id: string
          _tokens: number
          _user_id: string
        }
        Returns: {
          already_credited: boolean
          balance: number
          credited: number
        }[]
      }
      credit_token_purchase: {
        Args: {
          _amount_total: number
          _currency: string
          _price_id: string
          _session_id: string
          _tokens: number
          _user_id: string
        }
        Returns: {
          already_credited: boolean
          balance: number
          credited: number
        }[]
      }
      credit_user_tokens: {
        Args: {
          acting_admin_id?: string
          idempotency_key?: string
          reason?: string
          target_user_id: string
          token_amount: number
        }
        Returns: {
          already_applied: boolean
          balance: number
          user_id: string
        }[]
      }
      credit_v_token_purchase: {
        Args: {
          _amount_total?: number
          _currency?: string
          _price_id: string
          _session_id: string
          _tokens: number
          _user_id: string
        }
        Returns: {
          already_credited: boolean
          balance: number
          credited: number
        }[]
      }
      redeem_artist_track_download: {
        Args: {
          _track_artist: string
          _track_id: string
          _track_title: string
          _user_id: string
        }
        Returns: {
          already_owned: boolean
          balance: number
          ok: boolean
          reason: string
        }[]
      }
      refund_user_tokens: {
        Args: {
          acting_admin_id?: string
          idempotency_key?: string
          reason?: string
          reference?: string
          target_user_id: string
          token_amount: number
        }
        Returns: {
          already_applied: boolean
          balance: number
          user_id: string
        }[]
      }
      spend_hybrid_tokens: {
        Args: {
          _amount: number
          _idempotency_key?: string
          _note?: string
          _user_id: string
        }
        Returns: {
          already_applied: boolean
          balance: number
          ok: boolean
          reason: string
        }[]
      }
      refund_hybrid_generation_tokens: {
        Args: {
          _amount: number
          _idempotency_key?: string
          _note?: string
          _user_id: string
        }
        Returns: {
          already_applied: boolean
          balance: number
          ok: boolean
          reason: string
        }[]
      }
      spend_v_tokens: {
        Args: {
          _amount: number
          _idempotency_key?: string
          _note?: string
          _user_id: string
        }
        Returns: {
          already_applied: boolean
          balance: number
          ok: boolean
          reason: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "staff" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "staff", "user"],
    },
  },
} as const
