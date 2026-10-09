export type ReleaseType = "Single" | "EP" | "Album" | "Compilation" | "MusicVideo";

export type ReleaseStatus = "draft" | "in_review" | "live" | "takedown_pending";

export interface Participant {
  name: string;
  role: string[];
  artistId?: number;
}

export interface WriterCredit {
  name: string;
  role: string[];
}

export interface ReleaseTrack {
  id?: number;
  title: string;
  language?: string;
  audioFileKey?: string;
  isrc?: string;
  tiktokStartTime?: string;
  instrumental?: boolean;
  lyrics?: { explicit?: boolean };
  artists?: Participant[];
  writers?: WriterCredit[];
}

export interface DeliverySettings {
  platforms: string[];
  territories: string[];
  additional?: { youtube?: boolean };
}

export interface Release {
  id: number;
  title: string;
  type: ReleaseType;
  label?: string;
  genre?: string;
  upc?: string;
  spotifyUri?: string;
  status: ReleaseStatus;
  participants: Participant[];
  coverFileKey?: string;
  coverUrl?: string;
  tracks?: ReleaseTrack[];
  delivery?: DeliverySettings;
  updatedAt?: string;
}

export interface ReleaseList {
  data: Release[];
  totalItems: number;
}

export interface UploadTarget {
  uploadUrl: string;
  fileKey: string;
  headers: Record<string, string>;
}

/** Enterprise defaults. Callers must send these; the distribution form cannot turn them off. */
export const ENTERPRISE_RELEASE_FLAGS = {
  enable_content_id: true,
  enable_publishing_admin: true,
  enable_discovery_mode: true,
  auto_generate_isrc: true,
  auto_generate_upc: true,
  territories: "worldwide",
  stores: "all",
} as const;

export type CatalogReleaseType = "single" | "ep" | "album";

export interface AdditionalDelivery {
  youtube_content_id: boolean;
  meta_rights_manager: boolean;
  soundcloud_monetization: boolean;
  soundexchange: boolean;
  tracklib: boolean;
  hook: boolean;
  roblox: boolean;
  managed_media: boolean;
  lyricfind: boolean;
  beatport: boolean;
  udio_training: false;
}

export interface DraftReleaseInput {
  title: string;
  type: "Single" | "EP" | "Album";
  release_type: CatalogReleaseType;
  label?: string;
  upc?: string;
  genre?: string;
  primary_genre: string;
  participants: { name: string; role: string[] }[];
  primary_artist_id: string | number | null;
  primary_artist_name: string;
  release_date: string;
  language: "English";
  is_instrumental: boolean;
  c_line: string;
  p_line: string;
  licensing_type: "Copyright";
  itunes_track_price: "1.29";
  itunes_album_price: "4.99";
  additional_delivery: AdditionalDelivery;
  enable_content_id: true;
  enable_publishing_admin: true;
  enable_discovery_mode: true;
  auto_generate_isrc: true;
  auto_generate_upc: true;
  territories: "worldwide";
  stores: "all";
}

export interface TrackWrite {
  title: string;
  language: string;
  audioFileKey: string;
  tiktokStartTime: string;
  isrc?: string;
  instrumental?: boolean;
  lyrics: { explicit: boolean };
  artists: { name: string; role: string[] }[];
  writers: { name: string; role: string[] }[];
  composer: string;
  lyricist: string;
  p_line: string;
  c_line: string;
  recording_type: string;
  is_explicit: boolean;
}

export interface DeliveryWrite {
  platforms: string[];
  territories: string[];
  additional: { youtube: boolean };
}

export interface SubmitWrite {
  acceptTerms: true;
  confirmRights: true;
  confirmYoutubeRights: boolean;
  idempotencyKey: string;
}

export const STATUS_LABEL: Record<ReleaseStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  live: "Live",
  takedown_pending: "Takedown pending",
};

export const RELEASE_STATUSES: ReleaseStatus[] = [
  "draft",
  "in_review",
  "live",
  "takedown_pending",
];
