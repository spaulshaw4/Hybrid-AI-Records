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
  upc?: string;
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

export interface DraftReleaseInput {
  title: string;
  type: "Single" | "EP" | "Album";
  label?: string;
  upc?: string;
  participants: { name: string; role: string[] }[];
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
