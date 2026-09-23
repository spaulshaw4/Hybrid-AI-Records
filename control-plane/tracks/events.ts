import { Topic } from "encore.dev/pubsub";

/** Published once when a job reaches a terminal state. */
export interface TrackEvent {
  sessionId: string;
  title: string;
  genre: string;
  status: "completed" | "failed";
  lufs?: number;
  truePeakDbTp?: number;
  provenanceScore?: number;
  provenanceStatus?: string;
  /** Time-limited signed download URLs (see SLACK_LINK_TTL_SECONDS). */
  masterUrl?: string;
  zipUrl?: string;
  manifestUrl?: string;
  linksExpireAt?: string;
  errorMessage?: string;
  failedStage?: string;
}

export const trackEventsTopic = new Topic<TrackEvent>("track-events", {
  deliveryGuarantee: "at-least-once",
});
