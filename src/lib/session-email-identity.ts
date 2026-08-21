/**
 * Browser-safe sender identity for vocal-session notifications.
 *
 * Lives outside the server-only mailer so admin UI (email detail modal,
 * previews) can display the exact From/Reply-To headers used at send time.
 */

/**
 * Until a verified sender domain is live this falls back to Resend's shared
 * onboarding address, which only delivers to the label's own inbox.
 */
export const SESSION_EMAIL_FROM = "Hybrid AI Records <onboarding@resend.dev>";

/** Address artists reach when they reply to a notification. */
export const SESSION_EMAIL_REPLY_TO = "Hybrid.AI.Records@proton.me";
