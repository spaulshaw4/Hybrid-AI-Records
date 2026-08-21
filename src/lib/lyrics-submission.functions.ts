import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * "Lyrics Only" intake. The row is written server-side so we can also mint a
 * single-use signed upload URL scoped to that submission's folder — visitors
 * never get generic write access to the bucket.
 */
const BUCKET = "artist-uploads";

const ALLOWED_EXT = [".txt", ".md", ".rtf", ".pdf", ".doc", ".docx", ".pages"];

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "lyrics.txt";
}

const schema = z
  .object({
    artist: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    language: z.string().trim().min(1).max(64),
    lyricsText: z.string().trim().max(20000).optional(),
    notes: z.string().trim().max(1000).optional(),
    packageSlug: z.string().trim().max(64).optional(),
    packageLabel: z.string().trim().max(120).optional(),
    fileName: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.lyricsText?.length) || Boolean(v.fileName?.length), {
    message: "Paste your lyrics or attach a lyrics file.",
  })
  .refine(
    (v) => !v.fileName || ALLOWED_EXT.some((ext) => v.fileName!.toLowerCase().endsWith(ext)),
    { message: "Lyrics files must be .txt, .md, .rtf, .pdf, .doc, .docx or .pages." },
  );

export const submitLyrics = createServerFn({ method: "POST" })
  .inputValidator((data) => schema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const day = new Date().toISOString().slice(0, 10);
    const filePath = data.fileName
      ? `lyrics/${day}/${crypto.randomUUID()}-${safeName(data.fileName)}`
      : null;

    const { data: row, error } = await supabaseAdmin
      .from("lyrics_submissions")
      .insert({
        artist: data.artist,
        email: data.email,
        language: data.language,
        lyrics_text: data.lyricsText ?? null,
        notes: data.notes ?? null,
        package_slug: data.packageSlug ?? null,
        package_label: data.packageLabel ?? null,
        file_path: filePath,
        file_name: data.fileName ?? null,
      })
      .select("id")
      .single();

    if (error || !row) {
      return {
        ok: false as const,
        message: "We couldn't save your lyrics right now. Please try again in a moment.",
      };
    }

    if (!filePath) return { ok: true as const, id: row.id, upload: null };

    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(filePath);

    if (signError || !signed) {
      return {
        ok: true as const,
        id: row.id,
        upload: null,
        warning: "Your lyrics were saved, but the file upload slot couldn't be opened.",
      };
    }

    return {
      ok: true as const,
      id: row.id,
      upload: { path: signed.path, token: signed.token },
    };
  });
