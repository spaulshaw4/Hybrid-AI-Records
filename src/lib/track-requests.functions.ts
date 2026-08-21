import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isEditable } from "@/lib/track-request-state";
import { checkArtistName, checkEmail, checkLink, checkNotes } from "@/lib/form-guard";

/** Same spam rules the browser enforces, re-applied to direct API callers. */
const guard = (check: (v: string) => string | null) =>
  (v: string, ctx: z.RefinementCtx) => {
    const problem = check(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  };

export const TRACK_STATUS_STEPS = [
  {
    key: "received",
    label: "Submission received",
    detail: "Your application landed in the Hybrid AI Records queue.",
  },
  {
    key: "in_review",
    label: "Under review",
    detail: "Our team is listening to your material and checking package fit.",
  },
  {
    key: "plan_sent",
    label: "Plan sent",
    detail: "Scope, timeline, and pricing confirmation emailed to you.",
  },
  {
    key: "in_production",
    label: "In production",
    detail: "Your track is being produced. Checkpoints arrive by email.",
  },
  {
    key: "delivered",
    label: "Delivered",
    detail: "Release-ready masters (and video, if included) delivered.",
  },
] as const;

export type TrackStatusKey = (typeof TRACK_STATUS_STEPS)[number]["key"];

const createSchema = z.object({
  artist: z.string().trim().min(1).max(200).superRefine(guard(checkArtistName)),
  email: z.string().trim().email().max(255).superRefine(guard(checkEmail)),
  packageLabel: z.string().trim().min(1).max(200),
  fileName: z.string().trim().max(300).optional().nullable(),
  link: z
    .string()
    .trim()
    .max(600)
    .optional()
    .nullable()
    .superRefine((v, ctx) => guard(checkLink)(v ?? "", ctx)),
  notes: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .nullable()
    .superRefine((v, ctx) => guard(checkNotes)(v ?? "", ctx)),
  acknowledged: z.boolean(),
});

const lookupSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().email().max(255),
});

const noteSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().email().max(255),
  note: z.string().trim().max(2000),
});

/** Artist-authored revision request; `newRound` starts a fresh revision round. */
const revisionSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().email().max(255),
  request: z
    .string()
    .trim()
    .max(4000)
    .superRefine((v, ctx) => guard(checkNotes)(v, ctx)),
  newRound: z.boolean().default(false),
});


/**
 * Edits allowed before the submission is locked: the HAR reference, contact
 * email, and package stay fixed so the record (and any payment) still lines up.
 */
const editSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().email().max(255),
  artist: z.string().trim().min(1).max(200).superRefine(guard(checkArtistName)),
  link: z
    .string()
    .trim()
    .max(600)
    .superRefine((v, ctx) => guard(checkLink)(v, ctx)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .superRefine((v, ctx) => guard(checkNotes)(v, ctx)),
});

/** HAR-9F3K2Q style reference the artist can quote back to us. */
function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `HAR-${body}`;
}

/** Stores the submission so the artist can track it later. Public by design. */
export const createTrackRequest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => createSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Retry a couple of times in the very unlikely event of a code collision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reference = makeReference();
      const { error } = await supabaseAdmin.from("track_requests").insert({
        reference_code: reference,
        artist: data.artist,
        email: data.email.toLowerCase(),
        package_label: data.packageLabel,
        file_name: data.fileName ?? null,
        link: data.link ?? null,
        notes: data.notes ?? null,
        acknowledged: data.acknowledged,
        status: "received",
      });
      if (!error) return { ok: true as const, reference };
      if (error.code !== "23505") {
        console.error("Track request insert failed:", error.message);
        return { ok: false as const, reference: null };
      }
    }
    return { ok: false as const, reference: null };
  });

/**
 * Reads one request. Requires the reference code AND the matching contact
 * email so a guessed code alone never exposes someone else's submission.
 */
export const lookupTrackRequest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => lookupSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("track_requests")
      .select(
        "reference_code, artist, email, package_label, file_name, link, notes, acknowledged, status, status_note, artist_note, paid_at, paid_amount_label, payment_currency, review_started_at, revision_request, revision_updated_at, revision_round, locked_tier, locked_turnaround_label, locked_delivery_earliest, locked_delivery_latest, tier_locked_at, created_at, updated_at",
      )

      .eq("reference_code", data.reference.trim().toUpperCase())
      .maybeSingle();

    if (error) {
      console.error("Track lookup failed:", error.message);
      throw new Error("Status lookup is temporarily unavailable. Try again shortly.");
    }

    if (!row || row.email.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { found: false as const };
    }

    return {
      found: true as const,
      request: {
        reference: row.reference_code,
        artist: row.artist,
        email: row.email,
        packageLabel: row.package_label,
        fileName: row.file_name,
        link: row.link,
        notes: row.notes,
        acknowledged: row.acknowledged,
        status: row.status as TrackStatusKey,
        statusNote: row.status_note,
        artistNote: row.artist_note,
        paidAt: row.paid_at,
        paidAmountLabel: row.paid_amount_label,
        paymentCurrency: row.payment_currency,
        reviewStartedAt: row.review_started_at,
        revisionRequest: row.revision_request,
        revisionUpdatedAt: row.revision_updated_at,
        revisionRound: row.revision_round ?? 0,
        lockedTier: row.locked_tier ?? null,
        lockedTurnaroundLabel: row.locked_turnaround_label ?? null,
        lockedDeliveryEarliest: row.locked_delivery_earliest ?? null,
        lockedDeliveryLatest: row.locked_delivery_latest ?? null,
        tierLockedAt: row.tier_locked_at ?? null,

        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  });

/**
 * Lets the artist write/replace their own note on the submission. Guarded by
 * the same reference-code + matching-email pair used for lookups.
 */
export const updateTrackArtistNote = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => noteSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const reference = data.reference.trim().toUpperCase();

    const { data: row, error: readError } = await supabaseAdmin
      .from("track_requests")
      .select("email")
      .eq("reference_code", reference)
      .maybeSingle();

    if (readError) {
      console.error("Artist note lookup failed:", readError.message);
      throw new Error("Could not save your note. Try again shortly.");
    }
    if (!row || row.email.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { ok: false as const, note: null };
    }

    const note = data.note.length > 0 ? data.note : null;
    const { error } = await supabaseAdmin
      .from("track_requests")
      .update({ artist_note: note })
      .eq("reference_code", reference);

    if (error) {
      console.error("Artist note update failed:", error.message);
      throw new Error("Could not save your note. Try again shortly.");
    }
    return { ok: true as const, note };
  });

/**
 * Lets the artist correct their own details while the submission is still
 * open — i.e. nothing is paid yet and review has not started. The reference
 * code never changes, so links, receipts, and emails stay valid.
 */
export const updateTrackRequestDetails = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => editSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const reference = data.reference.trim().toUpperCase();

    const { data: row, error: readError } = await supabaseAdmin
      .from("track_requests")
      .select("email, status, paid_at, review_started_at")
      .eq("reference_code", reference)
      .maybeSingle();

    if (readError) {
      console.error("Edit lookup failed:", readError.message);
      throw new Error("Could not save your changes. Try again shortly.");
    }
    if (!row || row.email.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { ok: false as const, reason: "not-found" as const, request: null };
    }
    if (!isEditable({ status: row.status, paidAt: row.paid_at, reviewStartedAt: row.review_started_at })) {
      return { ok: false as const, reason: "locked" as const, request: null };
    }

    const { data: updated, error } = await supabaseAdmin
      .from("track_requests")
      .update({
        artist: data.artist,
        link: data.link.length > 0 ? data.link : null,
        notes: data.notes.length > 0 ? data.notes : null,
      })
      .eq("reference_code", reference)
      .is("paid_at", null)
      .eq("status", "received")
      .select("artist, link, notes, updated_at")
      .maybeSingle();

    if (error) {
      console.error("Edit update failed:", error.message);
      throw new Error("Could not save your changes. Try again shortly.");
    }
    if (!updated) {
      // Locked in between the read and the write (e.g. payment just landed).
      return { ok: false as const, reason: "locked" as const, request: null };
    }

    return {
      ok: true as const,
      reason: null,
      request: {
        artist: updated.artist,
        link: updated.link,
        notes: updated.notes,
        updatedAt: updated.updated_at,
      },
    };
  });

/**
 * Lets the artist file or update their revision request. Same reference-code +
 * matching-email guard as every other artist-facing write. `newRound` bumps
 * the revision counter so the team can see how many rounds were requested.
 */
export const updateRevisionRequest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => revisionSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const reference = data.reference.trim().toUpperCase();

    const { data: row, error: readError } = await supabaseAdmin
      .from("track_requests")
      .select("email, revision_round")
      .eq("reference_code", reference)
      .maybeSingle();

    if (readError) {
      console.error("Revision lookup failed:", readError.message);
      throw new Error("Could not save your revision request. Try again shortly.");
    }
    if (!row || row.email.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { ok: false as const, request: null, round: 0, updatedAt: null };
    }

    const text = data.request.length > 0 ? data.request : null;
    const currentRound = row.revision_round ?? 0;
    // A cleared request never counts as a round; a new round only when asked.
    const round = text && data.newRound ? Math.min(currentRound + 1, 99) : currentRound;
    const updatedAt = text ? new Date().toISOString() : null;

    const { error } = await supabaseAdmin
      .from("track_requests")
      .update({
        revision_request: text,
        revision_updated_at: updatedAt,
        revision_round: round,
      })
      .eq("reference_code", reference);

    if (error) {
      console.error("Revision update failed:", error.message);
      throw new Error("Could not save your revision request. Try again shortly.");
    }
    return { ok: true as const, request: text, round, updatedAt };
  });
