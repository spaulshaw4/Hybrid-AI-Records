/**
 * Staff read-side for the upload audit log. RLS on public.upload_audit_log
 * restricts SELECT to admin/staff, so this simply reads as the caller.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type UploadAuditRow = {
  id: string;
  action: string;
  bucket: string;
  object_path: string;
  file_name: string | null;
  file_size: number | null;
  reference_code: string | null;
  user_id: string | null;
  outcome: string;
  error_message: string | null;
  created_at: string;
};

export const listUploadAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) =>
    z
      .object({
        action: z.enum(["all", "upload", "replace", "delete"]).default("all"),
        outcome: z.enum(["all", "success", "failed"]).default("all"),
        search: z.string().trim().max(64).default(""),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: UploadAuditRow[] }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (context.supabase as any)
      .from("upload_audit_log")
      .select(
        "id, action, bucket, object_path, file_name, file_size, reference_code, user_id, outcome, error_message, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.action !== "all") query = query.eq("action", data.action);
    if (data.outcome !== "all") query = query.eq("outcome", data.outcome);
    if (data.search) {
      const term = data.search.replace(/[%,]/g, "");
      query = query.or(
        `reference_code.ilike.%${term}%,file_name.ilike.%${term}%,object_path.ilike.%${term}%`,
      );
    }

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as UploadAuditRow[] };
  });
