import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const draftPayloadSchema = z.object({
  artist: z.string().max(200).default(""),
  email: z.string().max(255).default(""),
  pkg: z.string().max(200).default(""),
  link: z.string().max(600).default(""),
  notes: z.string().max(4000).default(""),
  ack: z.boolean().default(false),
});

const syncSchema = z.object({
  email: z.string().trim().email().max(255),
  payload: draftPayloadSchema,
  // Capability secret proving the caller is the person who started this draft.
  ownerKey: z.string().trim().min(20).max(200).optional().nullable(),
});

const resumeRequestSchema = z.object({
  email: z.string().trim().email().max(255),
  // Only used as a hint; the server re-validates it against its own allowlist.
  origin: z.string().trim().url().max(300).optional(),
});

const loadSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

/**
 * Saves (or overwrites) the draft for this email address.
 *
 * Ownership: the first save for an email mints a random owner key that only
 * that browser keeps. Later saves for the same email must present it, so a
 * stranger who merely knows the address can't overwrite the draft.
 */
export const syncDraftToCloud = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => syncSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { randomBytes, createHash } = await import("node:crypto");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");

    const email = data.email.toLowerCase();
    const { data: existing, error: readError } = await supabaseAdmin
      .from("form_drafts")
      .select("id, owner_key_hash")
      .eq("email", email)
      .maybeSingle();
    if (readError) {
      console.error("Draft owner lookup failed:", readError.message);
      throw new Error("Draft could not be saved to your account");
    }

    let ownerKey = data.ownerKey?.trim() || null;

    if (existing) {
      const matches =
        Boolean(existing.owner_key_hash) &&
        Boolean(ownerKey) &&
        existing.owner_key_hash === hash(ownerKey!);
      if (!matches) {
        // Someone else's draft (or a browser that lost its key): never clobber it.
        return { ok: false as const, reason: "not_owner" as const, savedAt: null };
      }
      const { error } = await supabaseAdmin
        .from("form_drafts")
        .update({ payload: data.payload })
        .eq("email", email);
      if (error) {
        console.error("Draft sync failed:", error.message);
        throw new Error("Draft could not be saved to your account");
      }
      return { ok: true as const, savedAt: Date.now(), ownerKey };
    }

    ownerKey = randomBytes(32).toString("base64url");
    const { error } = await supabaseAdmin
      .from("form_drafts")
      .insert({ email, payload: data.payload, owner_key_hash: hash(ownerKey) });
    if (error) {
      console.error("Draft sync failed:", error.message);
      throw new Error("Draft could not be saved to your account");
    }
    return { ok: true as const, savedAt: Date.now(), ownerKey };
  });

/** Emails a one-time, 24-hour link that restores the draft on any device. */
export const emailDraftResumeLink = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => resumeRequestSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { randomBytes, createHash } = await import("node:crypto");

    const email = data.email.toLowerCase();
    const { data: existing, error: readError } = await supabaseAdmin
      .from("form_drafts")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (readError) {
      console.error("Draft lookup failed:", readError.message);
      throw new Error("We couldn't reach your saved draft right now");
    }
    if (!existing) {
      return { ok: false as const, reason: "no_draft" as const };
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabaseAdmin
      .from("form_drafts")
      .update({ resume_token_hash: tokenHash, token_expires_at: expires })
      .eq("email", email);
    if (updateError) {
      console.error("Draft token save failed:", updateError.message);
      throw new Error("We couldn't create your resume link");
    }

    const lovableKey = process.env['LOVABLE_API_KEY'];
    const resendKey = process.env['RESEND_API_KEY'];
    if (!lovableKey || !resendKey) {
      throw new Error("Email service is not configured");
    }

    const { resolveOriginWithAudit } = await import("@/lib/site-origin.server");
    const { origin: safeOrigin, allowed: originAllowed } = resolveOriginWithAudit(
      data.origin,
      "draft_resume_link",
      { emailDomain: data.email.split("@")[1] ?? "unknown" },
    );
    const originFallback = !originAllowed;
    const resumeUrl = `${safeOrigin}/?resume=${token}`;
    const html = `
      <div style="font-family:Arial,sans-serif;color:#111;line-height:1.6;">
        <h2 style="margin:0 0 16px;color:#e11d2e;">Continue your Hybrid AI Records application</h2>
        <p>Open the secure link below on any device to restore your saved answers and finish submitting your track.</p>
        <p><a href="${resumeUrl}" style="background:#e11d2e;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;display:inline-block;">Continue my application</a></p>
        <p style="font-size:13px;color:#555;">This link works once and expires in 24 hours. If you didn't request it, you can ignore this email.</p>
      </div>
    `;

    const response = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": resendKey,
      },
      body: JSON.stringify({
        from: "Hybrid AI Records <onboarding@resend.dev>",
        to: [email],
        subject: "Your saved Hybrid AI Records application",
        html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`Resume link email failed [${response.status}]: ${body}`);
      throw new Error(`Email send failed [${response.status}]`);
    }

    return { ok: true as const, originFallback, resumeOrigin: safeOrigin };
  });

/** Exchanges a one-time resume token for the stored draft. */
export const loadDraftByToken = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => loadSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createHash, randomBytes } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(data.token).digest("hex");

    const { data: row, error } = await supabaseAdmin
      .from("form_drafts")
      .select("email, payload, token_expires_at, updated_at")
      .eq("resume_token_hash", tokenHash)
      .maybeSingle();

    if (error) {
      console.error("Draft restore failed:", error.message);
      throw new Error("We couldn't restore your draft right now");
    }
    if (!row || !row.token_expires_at || new Date(row.token_expires_at).getTime() < Date.now()) {
      return { ok: false as const, reason: "invalid_or_expired" as const };
    }

    // One-time use: burn the token now that it has been redeemed, and hand the
    // resuming device a fresh owner key so it can keep saving this draft.
    const ownerKey = randomBytes(32).toString("base64url");
    await supabaseAdmin
      .from("form_drafts")
      .update({
        resume_token_hash: null,
        token_expires_at: null,
        owner_key_hash: createHash("sha256").update(ownerKey).digest("hex"),
      })
      .eq("email", row.email);

    const payload = draftPayloadSchema.partial().parse(row.payload ?? {});
    return {
      ok: true as const,
      payload,
      ownerKey,
      savedAt: new Date(row.updated_at).getTime(),
    };
  });

/**
 * Clears the cloud copy once the application has actually been submitted.
 * Requires the owner key, so only the device that created the draft can delete it.
 */
export const clearCloudDraft = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        ownerKey: z.string().trim().min(20).max(200),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createHash } = await import("node:crypto");
    const { error } = await supabaseAdmin
      .from("form_drafts")
      .delete()
      .eq("email", data.email.toLowerCase())
      .eq("owner_key_hash", createHash("sha256").update(data.ownerKey).digest("hex"));
    if (error) {
      console.error("Draft clear failed:", error.message);
      return { ok: false as const };
    }
    return { ok: true as const };
  });
