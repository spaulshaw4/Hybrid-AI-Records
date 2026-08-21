import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Guest uploads no longer rely on "knowing a reference code". Storage refuses
 * anonymous writes outright; instead the artist proves ownership of the order
 * by supplying the contact email it was booked with, and only then does the
 * server mint a short-lived, single-use signed upload URL for one exact path.
 */
const BUCKET = "artist-uploads";

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

/** Strips anything that could escape the reference folder. */
function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
}

export const requestUploadTicket = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        reference: z.string().trim().min(3).max(64).regex(REFERENCE_PATTERN),
        email: z.string().trim().email().max(200),
        fileName: z.string().trim().min(1).max(200),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: match, error: checkError } = await supabaseAdmin
      .from("track_requests")
      .select("id, email")
      .eq("reference_code", data.reference)
      .limit(5);

    const verified =
      !checkError &&
      (match ?? []).some((row) => row.email.trim().toLowerCase() === data.email.toLowerCase());

    if (!verified) {

      return {
        ok: false as const,
        reason: "unverified" as const,
        message:
          "That reference code and email don't match an order. Use the exact code and the email address the order was placed with.",
      };
    }

    const day = new Date().toISOString().slice(0, 10);
    const path = `${data.reference}/${day}/${Date.now()}-${safeName(data.fileName)}`;

    const { data: signed, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error || !signed) {
      return {
        ok: false as const,
        reason: "storage" as const,
        message: "Couldn't open an upload slot right now. Try again in a moment.",
      };
    }

    return { ok: true as const, path: signed.path, token: signed.token };
  });
