/**
 * Browser-safe sender identity for vocal-session notifications.
 *
 * Lives outside the server-only mailer so admin UI (email detail modal,
 * previews) can display the exact From/Reply-To headers used at send time.
 */

/**
 * Verified sender on hybrid-ai-records.com. Session notifications and other
 * transactional mail inherit this unless a send already names its own
 * local-part on that domain.
 */
export const SESSION_EMAIL_FROM = "Hybrid AI Records <certification@hybrid-ai-records.com>";

/** Address artists reach when they reply to a notification. */
export const SESSION_EMAIL_REPLY_TO = "Hybrid.AI.Records@proton.me";
