import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listVocalSessions from "./tools/list-vocal-sessions";
import listSessionEmails from "./tools/list-session-emails";
import listLyricsSubmissions from "./tools/list-lyrics-submissions";
import listUploadAuditLog from "./tools/list-upload-audit-log";

// The OAuth issuer must be the direct Supabase host; the project ref is the only
// value that survives publish unchanged.
const projectRef = import.meta.env['VITE_SUPABASE_PROJECT_ID'] ?? "project-ref-unset";

export default defineMcp({
  name: "hybrid-ai-forge",
  title: "Hybrid AI Forge",
  version: "0.1.0",
  instructions:
    "Tools for Hybrid AI Records staff. Read vocal session bookings, their notification email delivery log, artist lyrics submissions and the artist upload audit log. All access runs as the signed-in user under row-level security.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listVocalSessions, listSessionEmails, listLyricsSubmissions, listUploadAuditLog],
});
