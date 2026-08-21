import { z } from "zod";

/**
 * Shared, richly annotated schema fragments so MCP clients can auto-build
 * argument forms from `tools/list` metadata (titles, descriptions, enums,
 * ranges and defaults all travel in the emitted JSON Schema).
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const limitInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(
    `Maximum number of rows to return. Between 1 and ${MAX_LIMIT}; defaults to ${DEFAULT_LIMIT}.`,
  );

export function clampLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

const isoTimestamp = z.string().describe("ISO 8601 timestamp (UTC).");

export const vocalSessionRow = z.object({
  id: z.string().describe("Vocal session request id (UUID)."),
  artist: z.string().describe("Artist name supplied on the booking."),
  email: z.string().describe("Contact email for the booking."),
  timezone: z.string().describe("IANA timezone the artist selected, e.g. America/New_York."),
  package_label: z.string().nullable().describe("Human-readable package the session belongs to."),
  status: z.string().describe("Booking status: requested, confirmed, rescheduled, declined or cancelled."),
  confirmed_slot: z.unknown().nullable().describe("Confirmed slot object, or null while pending."),
  meeting_link: z.string().nullable().describe("Generated video-chat link for the session."),
  created_at: isoTimestamp,
});

export const sessionEmailRow = z.object({
  id: z.string().describe("Email log entry id (UUID)."),
  request_id: z.string().describe("Vocal session request this email belongs to."),
  kind: z.string().describe("Notification type, e.g. request or confirmation."),
  recipient: z.string().describe("Address the email was sent to."),
  subject: z.string().describe("Email subject line."),
  outcome: z.string().describe("Delivery outcome: sent, failed or pending."),
  reason: z.string().nullable().describe("Failure reason when the outcome is not sent."),
  created_at: isoTimestamp,
});

export const lyricsSubmissionRow = z.object({
  id: z.string().describe("Lyrics submission id (UUID)."),
  artist: z.string().describe("Artist name."),
  email: z.string().describe("Contact email."),
  package_label: z.string().nullable().describe("Package the lyrics were submitted against."),
  language: z.string().describe("Language of the submitted lyrics."),
  file_name: z.string().nullable().describe("Uploaded lyrics file name, if any."),
  status: z.string().describe("Review status, e.g. received."),
  created_at: isoTimestamp,
});

export const uploadAuditRow = z.object({
  id: z.string().describe("Audit entry id (UUID)."),
  action: z.string().describe("Action performed: upload, replace or delete."),
  bucket: z.string().describe("Storage bucket name."),
  object_path: z.string().describe("Path of the object inside the bucket."),
  file_name: z.string().nullable().describe("Original file name."),
  file_size: z.number().nullable().describe("File size in bytes."),
  reference_code: z.string().nullable().describe("Order/track reference the file belongs to."),
  outcome: z.string().describe("Result of the action: success or failed."),
  error_message: z.string().nullable().describe("Error detail when the action failed."),
  created_at: isoTimestamp,
});
