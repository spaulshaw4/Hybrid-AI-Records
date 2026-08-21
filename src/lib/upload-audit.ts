/**
 * Client-side writer for the upload audit log.
 *
 * Every file action against the artist-uploads bucket — upload, replace or
 * delete — is recorded here so staff can trace who touched which order.
 * Failures are logged too: a blocked upload is exactly what staff need to see.
 * Logging never throws; it must not break the artist's upload flow.
 */
import { supabase } from "@/integrations/supabase/client";

export type UploadAuditAction = "upload" | "replace" | "delete";

export type UploadAuditEntry = {
  action: UploadAuditAction;
  objectPath: string;
  fileName?: string | null;
  fileSize?: number | null;
  referenceCode?: string | null;
  outcome?: "success" | "failed";
  errorMessage?: string | null;
  /** Free-form JSON context — e.g. the exact metadata sent to storage. */
  details?: Record<string, unknown>;
  /** Defaults to the artist-uploads bucket. */
  bucket?: string;
};

const BUCKET = "artist-uploads";

export async function logUploadAction(entry: UploadAuditEntry): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    await supabase.from("upload_audit_log").insert({
      action: entry.action,
      bucket: (entry.bucket ?? BUCKET).slice(0, 64),
      object_path: entry.objectPath.slice(0, 512),
      file_name: entry.fileName ? entry.fileName.slice(0, 256) : null,
      file_size: typeof entry.fileSize === "number" ? Math.max(0, Math.round(entry.fileSize)) : null,
      reference_code: entry.referenceCode ? entry.referenceCode.slice(0, 64) : null,
      user_id: auth.user?.id ?? null,
      outcome: entry.outcome ?? "success",
      error_message: entry.errorMessage ? entry.errorMessage.slice(0, 500) : null,
      details: (entry.details ?? {}) as never,
    });
  } catch {
    // Audit logging is best-effort — never block the artist.
  }
}
