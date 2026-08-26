import { useEffect, useId, useRef, useState } from "react";
import { X, Upload, CheckCircle2, AlertCircle, Download, Copy } from "lucide-react";
import { recordReceipt } from "@/lib/receipt-history";
import { ReceiptBrandingPanel } from "@/components/ReceiptBrandingPanel";
import { DEFAULT_BRANDING, readBranding, type ReceiptBranding } from "@/lib/receipt-branding";

import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sendApplicationEmail } from "@/lib/application-email.functions";
import { createTrackRequest } from "@/lib/track-requests.functions";
import {
  syncDraftToCloud,
  emailDraftResumeLink,
  loadDraftByToken,
  clearCloudDraft,
} from "@/lib/draft-sync.functions";
import {
  HONEYPOT_FIELD,
  checkArtistName,
  checkBotSignals,
  checkEmail,
  checkLink,
  checkNotes,
  readSubmitHistory,
  recordSubmit,
} from "@/lib/form-guard";
import {
  DEFAULT_DRAFT_SCOPE,
  hasDraftContent,
  readDraft,
  removeDraft,
  writeDraft,
  type ApplicationDraft,
} from "@/lib/application-drafts";
import { clearHistory, recordSnapshot, type DraftSnapshot } from "@/lib/draft-history";
import DraftHistoryPanel from "@/components/DraftHistoryPanel";
import { pushDraftToAccount } from "@/lib/account-drafts";



export type PackageOption = {
  value: string;
  label: string;
};

export const PACKAGE_OPTIONS: PackageOption[] = [
  { value: "foundation_single", label: "Enterprise Distribution & Spotlight — Single Track ($25)" },
  { value: "foundation_bundle", label: "Enterprise Distribution & Spotlight — 10-Track Bundle ($250)" },

  { value: "visual_push_single", label: "The Visual Push — Single Track ($100)" },
  { value: "visual_push_bundle", label: "The Visual Push — 10-Track Bundle ($1,000)" },
  { value: "full_hybrid_single", label: "The Full Hybrid Experience — Single Track ($150)" },
  { value: "full_hybrid_bundle", label: "The Full Hybrid Experience — 10-Track Bundle ($1,500)" },
  { value: "standard_video_single", label: "Standard Video Package — HD ($350)" },
  { value: "video_4k_single", label: "4K HD Video Package — 4K ($400)" },
];

const ALLOWED_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "pdf", "doc", "docx", "txt"] as const;
const ACCEPTED_FILES =
  ".mp3,.wav,.m4a,.aac,.flac,.pdf,.doc,.docx,.txt,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ALLOWED_LIST = "MP3, WAV, M4A, AAC, FLAC, PDF, DOC, DOCX or TXT";
const MAX_FILE_MB = 50;

const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac"] as const;
const FORMAT_LABELS: Record<string, string> = {
  mp3: "MP3 audio",
  wav: "WAV audio",
  m4a: "M4A audio",
  aac: "AAC audio",
  flac: "FLAC audio",
  pdf: "PDF document",
  doc: "Word document",
  docx: "Word document",
  txt: "Plain text document",
};

const getExt = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
const isAudioFile = (name: string) =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(getExt(name));

const formatDuration = (seconds: number) => {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const spokenDuration = (seconds: number) => {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ");
};

type FileMeta = {
  name: string;
  formatLabel: string;
  sizeLabel: string;
  sizeBytes: number;
  typeLabel: string;
  isAudio: boolean;
  previewUrl: string | null;
  durationSeconds: number | null;
  durationError: string | null;
};

/** Reads duration from a local object URL without uploading anything. */
function probeAudioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const done = (value: number | null) => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 8000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = audio.duration;
      done(Number.isFinite(d) && d > 0 ? d : null);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    audio.src = url;
  });
}

/** Returns an actionable error message, or null when the file is acceptable. */
function validateFile(f: File): string | null {
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  if (!ext) {
    return `"${f.name}" has no file extension, so we can't tell what format it is. Rename it with a ${ALLOWED_LIST} extension and upload again.`;
  }
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `.${ext} files aren't supported. Please upload your track or lyrics as ${ALLOWED_LIST}. Tip: export audio as WAV or MP3, and documents as PDF.`;
  }
  if (f.size === 0) {
    return `"${f.name}" is empty (0 bytes). Check that the export finished, then upload the file again.`;
  }
  if (f.size > MAX_FILE_MB * 1024 * 1024) {
    return `"${f.name}" is ${formatMB(f.size)} — the limit is ${MAX_FILE_MB} MB. Compress it to MP3, or paste a Google Drive / Dropbox link in the External Link field below.`;
  }
  return null;
}


/** Turns a guard helper into a zod check that reports its exact message. */
const guarded = (check: (v: string) => string | null) =>
  (v: string, ctx: z.RefinementCtx) => {
    const problem = check(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  };

const applicationSchema = z.object({
  artist: z
    .string()
    .trim()
    .min(1, { message: "Enter your artist or band name." })
    .max(100, { message: "Artist name must be under 100 characters." })
    .superRefine(guarded(checkArtistName)),
  email: z
    .string()
    .trim()
    .min(1, { message: "Enter your email address." })
    .max(255, { message: "Email must be under 255 characters." })
    .superRefine(guarded(checkEmail)),
  pkg: z.string().min(1, { message: "Choose a package." }),
  link: z
    .string()
    .trim()
    .max(500, { message: "Link must be under 500 characters." })
    .superRefine(guarded(checkLink)),
  notes: z
    .string()
    .trim()
    .max(2000, { message: "Notes must be under 2000 characters." })
    .superRefine(guarded(checkNotes)),
});

type FieldName = "artist" | "email" | "pkg" | "link" | "notes" | "file" | "ack";
type Errors = Partial<Record<FieldName, string>>;

/* ------------- Server-side submit failures: classify + guide -------------- */

const SUBMIT_TIMEOUT_MS = 30_000;

class SubmitTimeoutError extends Error {
  constructor() {
    super("submit-timeout");
    this.name = "SubmitTimeoutError";
  }
}

class SubmitCancelledError extends Error {
  constructor() {
    super("submit-cancelled");
    this.name = "SubmitCancelledError";
  }
}

type SubmitFailure = {
  /** Short machine-ish reason, announced first. */
  title: string;
  /** Plain-language explanation of what went wrong. */
  detail: string;
  /** Ordered, actionable things the artist can do right now. */
  steps: string[];
  /** Field this failure belongs to, if any — drives inline + summary errors. */
  field?: FieldName;
  /** Whether re-submitting the same data is worth trying. */
  retryable: boolean;
  /** Raw technical error text, surfaced in the expandable details panel. */
  raw?: string;
  /** HTTP status code when the failure came from a server response. */
  status?: number;
};

/** Builds a readable technical dump for the expandable panel / clipboard. */
function rawErrorText(err: unknown): string {
  if (err instanceof Error) {
    return [`${err.name}: ${err.message}`, err.stack ? `\n${err.stack}` : ""].join("").trim();
  }
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
    } catch {
      return String(err);
    }
  }
  return String(err ?? "Unknown error");
}

const SUPPORT_EMAIL = "Hybrid.AI.Records@proton.me";

function classifySubmitFailure(err: unknown, attempt: number): SubmitFailure {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "Unknown error");
  const text = raw.toLowerCase();
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;

  if (err instanceof SubmitCancelledError) {
    return {
      title: "You cancelled the submission",
      detail:
        "The upload was stopped before it finished, so nothing was sent to the Hybrid team. Every answer and your attachment are still here.",
      steps: [
        "Review or change anything you want before sending.",
        "Choose Try again below when you're ready to submit.",
      ],
      retryable: true,
    };
  }

  if (offline) {
    return {
      title: "You appear to be offline",
      detail:
        "Your device lost its internet connection, so the application never reached our servers. Nothing was submitted, and your answers are still saved here.",
      steps: [
        "Reconnect to Wi-Fi or switch to mobile data.",
        "Wait a few seconds for the connection to settle.",
        "Choose Try again below — your answers and attachment are still filled in.",
      ],
      retryable: true,
    };
  }

  if (err instanceof SubmitTimeoutError || text.includes("timeout") || text.includes("timed out")) {
    return {
      title: "The submission timed out",
      detail: `Our server didn't respond within ${SUBMIT_TIMEOUT_MS / 1000} seconds. This usually means a slow connection or a large attachment, not a problem with your application.`,
      steps: [
        "Check that your connection is stable.",
        "If you attached a large file, remove it and paste a Google Drive, Dropbox, or SoundCloud link in the External Link field instead.",
        "Choose Try again below.",
      ],
      field: "file",
      retryable: true,
    };
  }

  if (status === 413 || text.includes("413") || text.includes("payload too large") || text.includes("entity too large")) {
    return {
      title: "Your attachment was too large for the server",
      detail:
        "The server rejected the submission because the attached file exceeded the accepted upload size.",
      steps: [
        "Remove the attached file using Remove file above.",
        "Upload the track to Google Drive, Dropbox, or SoundCloud.",
        "Paste that share link into the External Link field, then submit again.",
      ],
      field: "file",
      retryable: false,
    };
  }

  if (status === 415 || text.includes("unsupported media") || text.includes("415")) {
    return {
      title: "The server rejected that file type",
      detail: "The attachment format was not accepted during upload.",
      steps: [
        `Remove the file and re-export it as ${ALLOWED_LIST}.`,
        "Attach the converted file, then submit again.",
      ],
      field: "file",
      retryable: false,
    };
  }

  if (status === 422 || status === 400 || text.includes("invalid email") || text.includes("recipient")) {
    return {
      title: "The server couldn't accept these details",
      detail:
        "One of the submitted values was rejected during validation — most often the email address.",
      steps: [
        "Double-check your email address for typos.",
        "Make sure any external link starts with https:// and is publicly viewable.",
        "Correct the field, then submit again.",
      ],
      field: "email",
      retryable: true,
    };
  }

  if (status === 429 || text.includes("429") || text.includes("rate limit") || text.includes("too many")) {
    return {
      title: "Too many submissions in a short time",
      detail: "Our mail service is temporarily rate-limiting new applications from this connection.",
      steps: [
        "Wait about one minute.",
        "Choose Try again below — your answers stay saved in the meantime.",
        `If it keeps happening, email us directly at ${SUPPORT_EMAIL}.`,
      ],
      retryable: true,
    };
  }

  if ((status && status >= 500) || text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) {
    return {
      title: "Our server had a problem",
      detail:
        "The application reached us but our mail service returned an error, so we can't confirm it was delivered.",
      steps: [
        "Wait about 30 seconds, then choose Try again below.",
        attempt >= 2
          ? `This has now failed ${attempt} times — please email your details to ${SUPPORT_EMAIL} so we don't lose your submission.`
          : `If the second attempt also fails, email us at ${SUPPORT_EMAIL}.`,
      ],
      retryable: true,
    };
  }

  if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("load failed") || text.includes("network")) {
    return {
      title: "Network error while sending",
      detail:
        "The connection dropped partway through the upload, so the application never completed. Nothing was sent twice.",
      steps: [
        "Check your Wi-Fi or mobile signal.",
        "Disable any VPN or ad blocker that might be interrupting uploads.",
        "Choose Try again below.",
      ],
      retryable: true,
    };
  }

  return {
    title: "We couldn't send your application",
    detail: "Something unexpected went wrong on our side. Your answers have not been lost.",
    steps: [
      "Choose Try again below.",
      `If the problem continues, email your track details to ${SUPPORT_EMAIL} and we'll pick it up manually.`,
    ],
    retryable: true,
  };
}


/* ---------------- Draft autosave (local to this browser) -----------------
 * Storage lives in @/lib/application-drafts so every /start package option
 * gets its own autosaved slot that can be resumed independently.            */

type Draft = ApplicationDraft;


/* Capability key proving this browser owns the cloud copy of the draft. */
const OWNER_KEY_STORAGE = "hybrid.application.draft.owner.v1";

const readOwnerKey = (email: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OWNER_KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: string; key?: string };
    if (!parsed?.key || parsed.email?.toLowerCase() !== email.toLowerCase()) return null;
    return parsed.key;
  } catch {
    return null;
  }
};

const writeOwnerKey = (email: string, key: string) => {
  try {
    window.localStorage.setItem(
      OWNER_KEY_STORAGE,
      JSON.stringify({ email: email.toLowerCase(), key }),
    );
  } catch {
    /* storage unavailable — cloud sync simply stays read-only */
  }
};


/* ------- Submission progress persistence (survives refresh / reopen) ------- */

const PROGRESS_KEY = "hybrid.application.progress.v1";
// Anything older than this is stale: a submission never legitimately sits
// half-finished for an hour, so we start clean instead of resuming it.
const PROGRESS_TTL_MS = 60 * 60 * 1000;

type SendPhase = "idle" | "sending" | "done" | "error" | "cancelled";

type ActivityEntry = {
  at: number;
  stage: string;
  message: string;
  kind: "info" | "ok" | "warn" | "error";
};

type ProgressSnapshot = {
  phase: SendPhase;
  activity?: ActivityEntry[];
  progress: number;
  fileName: string | null;
  reference: string | null;
  submitted: boolean;
  receiptSent: boolean;
  savedAt: number;
};

// Progress lives in sessionStorage: it is per-tab state about one in-flight
// run, so a refresh or back navigation restores it while a brand new tab
// starts clean. Older builds wrote to localStorage — read that as a fallback.
const progressStore = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

// Lets the page reopen the form after a reload when an unfinished submission
// run is still stored, so the progress panel resumes instead of disappearing.
export const hasStoredProgress = (): boolean => readProgress() !== null;

const readProgress = (): ProgressSnapshot | null => {
  if (typeof window === "undefined") return null;
  try {
    let raw = progressStore()?.getItem(PROGRESS_KEY) ?? null;
    if (!raw) {
      raw = window.localStorage.getItem(PROGRESS_KEY);
      if (raw) window.localStorage.removeItem(PROGRESS_KEY);
    }
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ProgressSnapshot>;
    if (typeof p !== "object" || p === null) return null;
    const savedAt = Number(p.savedAt ?? 0);
    if (!savedAt || Date.now() - savedAt > PROGRESS_TTL_MS) return null;
    const phase = p.phase as SendPhase | undefined;
    if (!phase || phase === "idle") return null;
    return {
      // A page refresh kills any in-flight request, so a persisted "sending"
      // resumes as an interrupted run the artist can retry in one click.
      phase: phase === "sending" ? "error" : phase,
      progress: Math.max(0, Math.min(100, Number(p.progress ?? 0))),
      fileName: p.fileName ? String(p.fileName) : null,
      reference: p.reference ? String(p.reference) : null,
      submitted: Boolean(p.submitted),
      receiptSent: Boolean(p.receiptSent),
      activity: Array.isArray(p.activity)
        ? (p.activity as ActivityEntry[]).filter(
            (e) => e && typeof e.message === "string",
          )
        : [],
      savedAt,
    };
  } catch {
    return null;
  }
};

const writeProgress = (p: ProgressSnapshot) => {
  try {
    progressStore()?.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — progress simply won't survive a refresh */
  }
};

const removeProgress = () => {
  try {
    progressStore()?.removeItem(PROGRESS_KEY);
    window.localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
};

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });



export type ApplicationProgress = {
  /** True when every required field for the details step validates. */
  detailsComplete: boolean;
  /** True once the application has been submitted successfully. */
  submitted: boolean;
  /** Human-readable labels of the required fields still outstanding. */
  missing: string[];
};

interface Props {
  open: boolean;
  onClose: () => void;
  defaultPackage: string;
  /** Render as a page section instead of a focus-trapped overlay dialog. */
  inline?: boolean;
  /** Autosave slot id, so each package option keeps its own resumable draft. */
  draftScope?: string;
  /** Notified whenever required-field completeness changes. */
  onProgressChange?: (progress: ApplicationProgress) => void;
}

export function ApplicationModal({
  open,
  onClose,
  defaultPackage,
  inline = false,
  draftScope = DEFAULT_DRAFT_SCOPE,
  onProgressChange,
}: Props) {
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [pkg, setPkg] = useState(defaultPackage);
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [notes, setNotes] = useState("");
  const [ack, setAck] = useState(false);
  // Spam trap: hidden from people, irresistible to bots.
  const [honeypot, setHoneypot] = useState("");
  // When this visitor first saw the form — powers the "too fast" check.
  const startedAtRef = useRef<number>(Date.now());
  const [guardError, setGuardError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftStatus, setDraftStatus] = useState("");
  /** Bumped after each autosave so the version-history list stays current. */
  const [historyTick, setHistoryTick] = useState(0);
  const [cloudState, setCloudState] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [cloudSavedAt, setCloudSavedAt] = useState<number | null>(null);
  const [resumeState, setResumeState] = useState<"idle" | "sending" | "sent" | "none" | "error">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState<"idle" | "reading" | "done" | "error">("idle");
  const [uploadStatus, setUploadStatus] = useState("");
  const [sendProgress, setSendProgress] = useState(0);
  const [sendPhase, setSendPhase] = useState<
    "idle" | "sending" | "done" | "error" | "cancelled"
  >("idle");
  const [sendStatus, setSendStatus] = useState("");
  // Live activity log: a timestamped, human-readable account of what the
  // submission is doing inside each stage.
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const logActivity = (
    stage: string,
    message: string,
    kind: ActivityEntry["kind"] = "info",
  ) =>
    setActivity((prev) =>
      [...prev, { at: Date.now(), stage, message, kind }].slice(-40),
    );
  const cancelSubmitRef = useRef<(() => void) | null>(null);
  // Guards the cancel button: the artist has to confirm before we stop a run.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [needsReconfirm, setNeedsReconfirm] = useState(false);

  const [receiptSent, setReceiptSent] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  // Set when a persisted submission run is restored after a refresh/reopen.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [resumedFileName, setResumedFileName] = useState<string | null>(null);
  const progressRestoredRef = useRef(false);


  const [isDragging, setIsDragging] = useState(false);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const revokePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };
  useEffect(() => () => revokePreview(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const summaryRef = useRef<HTMLDivElement | null>(null);
  const guardRef = useRef<HTMLDivElement | null>(null);
  const successRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const [refocusForm, setRefocusForm] = useState(0);
  const failureRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const redirectTimerRef = useRef<number | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const resetAndCloseRef = useRef<() => void>(() => {});


  const hydratingRef = useRef(false);
  const resumeHandledRef = useRef(false);
  const sendEmail = useServerFn(sendApplicationEmail);
  const createRequest = useServerFn(createTrackRequest);
  const syncCloud = useServerFn(syncDraftToCloud);
  const sendResumeLink = useServerFn(emailDraftResumeLink);
  const restoreFromToken = useServerFn(loadDraftByToken);
  const clearCloud = useServerFn(clearCloudDraft);

  const needsAck = !pkg.startsWith("foundation_");

  // Restore any saved draft when the modal opens.
  useEffect(() => {
    if (!open) return;
    startedAtRef.current = Date.now();
    setHoneypot("");
    setGuardError(null);
    hydratingRef.current = true;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      // Drafts are sealed on disk, so restoring one is async.
      const draft = await readDraft(draftScope);
      if (cancelled) return;
      if (draft && hasDraftContent(draft)) {
        setArtist(draft.artist);
        setEmail(draft.email);
        setPkg(draft.pkg || defaultPackage);
        setLink(draft.link);
        setNotes(draft.notes);
        setAck(draft.ack);
        setDraftSavedAt(draft.savedAt || Date.now());
        setDraftRestored(true);
        setDraftStatus(
          `Draft restored from ${formatTime(draft.savedAt || Date.now())}. Your previously entered details were filled in. Attached files are not saved and must be re-attached.`,
        );
      } else {
        setPkg(defaultPackage);
        setDraftRestored(false);
        setDraftSavedAt(null);
        setDraftStatus("");
      }
      t = setTimeout(() => {
        hydratingRef.current = false;
      }, 0);
    })();
    return () => {
      cancelled = true;
      if (t) clearTimeout(t);
    };
  }, [open, defaultPackage, draftScope]);


  // Debounced autosave of in-progress answers.
  useEffect(() => {
    if (!open || submitted || submitting) return;
    if (hydratingRef.current) return;
    const t = setTimeout(async () => {
      const draft: Draft = {
        artist,
        email,
        pkg,
        link,
        notes,
        ack,
        savedAt: Date.now(),
      };
      if (!hasDraftContent(draft)) return;
      if (await writeDraft(draftScope, draft)) {
        // Keep a rollback point for this save.
        void recordSnapshot(draftScope, draft).then(() => setHistoryTick((t) => t + 1));
        setDraftSavedAt(draft.savedAt);
        setDraftStatus(`Draft saved at ${formatTime(draft.savedAt)}.`);
        // Optional account sync: mirrors the slot to the signed-in artist's
        // account so it can be resumed from another device after logging in.
        void pushDraftToAccount(draftScope, draft);

        // Mirror the draft to the secure backend so it can be resumed on
        // another device. Only possible once we have a valid email address.
        if (z.string().email().safeParse(draft.email.trim()).success) {
          setCloudState("syncing");
          syncCloud({ data: { email: draft.email.trim(), ownerKey: readOwnerKey(draft.email.trim()), payload: {
            artist: draft.artist, email: draft.email, pkg: draft.pkg,
            link: draft.link, notes: draft.notes, ack: draft.ack,
          } } })
            .then((res) => {
              if (!res.ok) {
                setCloudState("error");
                setDraftStatus(
                  `Draft saved on this device at ${formatTime(draft.savedAt)}. A saved application already exists for that email on another device — use "Email me a resume link" to continue it here.`,
                );
                return;
              }
              if (res.ownerKey) writeOwnerKey(draft.email.trim(), res.ownerKey);
              setCloudSavedAt(Date.now());
              setCloudState("synced");
              setDraftStatus(
                `Draft saved at ${formatTime(draft.savedAt)} and synced securely to your email address for other devices.`,
              );
            })
            .catch(() => {
              setCloudState("error");
              setDraftStatus(
                `Draft saved on this device at ${formatTime(draft.savedAt)}, but syncing to your other devices failed. It will retry as you keep typing.`,
              );
            });
        }
      } else {
        setDraftStatus(
          "Draft could not be saved in this browser. Copy your notes somewhere safe before closing.",
        );
      }
    }, 900);
    return () => clearTimeout(t);
  }, [open, submitted, submitting, artist, email, pkg, link, notes, ack]);

  // Restore a cloud draft when the artist arrives from a secure resume link.
  useEffect(() => {
    if (!open || resumeHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("resume");
    if (!token) return;
    resumeHandledRef.current = true;
    params.delete("resume");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
    hydratingRef.current = true;
    setDraftStatus("Restoring your saved application…");
    restoreFromToken({ data: { token } })
      .then((res) => {
        if (!res.ok) {
          setDraftStatus(
            "That resume link has expired or has already been used. Enter your email below and we can send you a fresh one.",
          );
          return;
        }
        const d = res.payload;
        setArtist(d.artist ?? "");
        setEmail(d.email ?? "");
        if (res.ownerKey && d.email) writeOwnerKey(d.email, res.ownerKey);
        if (d.pkg) setPkg(d.pkg);
        setLink(d.link ?? "");
        setNotes(d.notes ?? "");
        setAck(Boolean(d.ack));
        setDraftRestored(true);
        setDraftSavedAt(res.savedAt);
        setCloudSavedAt(res.savedAt);
        setCloudState("synced");
        setDraftStatus(
          `Saved application restored from ${formatTime(res.savedAt)}. Any attached file must be re-attached.`,
        );
      })
      .catch(() => {
        setDraftStatus(
          "We couldn't restore your saved application right now. Please try the link again in a moment.",
        );
      })
      .finally(() => {
        setTimeout(() => {
          hydratingRef.current = false;
        }, 0);
      });
  }, [open, restoreFromToken]);

  const requestResumeLink = () => {
    const target = email.trim();
    if (!z.string().email().safeParse(target).success) {
      setResumeState("error");
      setDraftStatus("Enter a valid contact email first so we know where to send your resume link.");
      return;
    }
    setResumeState("sending");
    setDraftStatus("Sending your secure resume link…");
    sendResumeLink({ data: { email: target, origin: window.location.origin } })
      .then((res) => {
        if (!res.ok) {
          setResumeState("none");
          setDraftStatus(
            "There's nothing saved for that email yet. Keep filling in the form — we save automatically.",
          );
          return;
        }
        setResumeState("sent");
        setDraftStatus(
          res.originFallback
            ? `Resume link sent to ${target}. For your security it opens on our official site (${res.resumeOrigin}) instead of this window — your saved answers will be waiting there.`
            : `Resume link sent to ${target}. Open it on any device within 24 hours to continue.`,
        );
      })
      .catch(() => {
        setResumeState("error");
        setDraftStatus("We couldn't send the resume link. Please try again in a moment.");
      });
  };

  // Editing anything after reaching the review step keeps the review panel open
  // (so the artist can jump back and forth) but flags it for re-confirmation.
  useEffect(() => {
    if (!reviewing || submitting) return;
    setNeedsReconfirm(true);
    setStatusMessage("Your answers changed. The final review updated — confirm again to submit.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, email, pkg, link, notes, ack, file]);


  const discardDraft = () => {
    removeDraft(draftScope);
    clearHistory(draftScope);
    setHistoryTick((t) => t + 1);
    setArtist("");
    setEmail("");
    setPkg(defaultPackage);
    setLink("");
    setNotes("");
    setAck(false);
    setErrors({});
    setShowSummary(false);
    setDraftRestored(false);
    setDraftSavedAt(null);
    setDraftStatus("Draft discarded. The form is now empty.");
  };

  /** Roll the form back to an earlier autosaved snapshot. */
  const restoreSnapshot = (snap: DraftSnapshot) => {
    setArtist(snap.artist);
    setEmail(snap.email);
    setPkg(snap.pkg || defaultPackage);
    setLink(snap.link);
    setNotes(snap.notes);
    setAck(snap.ack);
    setErrors({});
    setDraftRestored(true);
    setDraftSavedAt(snap.at);
    setDraftStatus(
      `Restored the version saved at ${formatTime(snap.at)}. Any attached file must be re-attached.`,
    );
  };


  // Move focus to the confirmation panel so screen readers land on next steps.
  useEffect(() => {
    if (!submitted) return;
    const t = requestAnimationFrame(() => successRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [submitted]);

  // Land focus on the submission progress screen as soon as sending starts.
  useEffect(() => {
    if (!submitting) return;
    const t = requestAnimationFrame(() => progressRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [submitting]);

  // Persist the submission run so a refresh or reopen resumes at the same
  // milestone instead of dropping the artist back on a blank progress panel.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sendPhase === "idle") {
      removeProgress();
      return;
    }
    writeProgress({
      phase: sendPhase,
      progress: sendProgress,
      fileName: file?.name ?? resumedFileName,
      reference,
      submitted,
      receiptSent,
      activity,
      savedAt: Date.now(),
    });
  }, [sendPhase, sendProgress, file, resumedFileName, reference, submitted, receiptSent, activity]);

  // Flush the latest stage state when the tab is hidden or unloaded, so a
  // refresh or back navigation restores the exact milestone we were on.
  const progressSnapRef = useRef<ProgressSnapshot | null>(null);
  progressSnapRef.current =
    sendPhase === "idle"
      ? null
      : {
          phase: sendPhase,
          progress: sendProgress,
          fileName: file?.name ?? resumedFileName,
          reference,
          submitted,
          receiptSent,
          activity,
          savedAt: Date.now(),
        };
  useEffect(() => {
    const flush = () => {
      const snap = progressSnapRef.current;
      if (snap) writeProgress({ ...snap, savedAt: Date.now() });
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, []);

  // Restore the persisted run once, the first time the modal opens.
  useEffect(() => {
    if (!open || progressRestoredRef.current) return;
    progressRestoredRef.current = true;
    const snap = readProgress();
    if (!snap) return;
    setSendPhase(snap.phase);
    setSendProgress(snap.progress);
    setResumedAt(snap.savedAt);
    setResumedFileName(snap.fileName);
    setReference(snap.reference);
    setReceiptSent(snap.receiptSent);
    setActivity(snap.activity ?? []);
    if (snap.phase === "done" && snap.submitted) {
      setSubmitted(true);
      setSendStatus("Restored: your application was already sent successfully.");
      setStatusMessage(
        "Restored your previous submission. It was sent successfully — no need to send it again.",
      );
      return;
    }
    const interrupted = snap.phase === "error";
    setSendStatus(
      interrupted
        ? `Restored an unfinished submission that stopped at ${snap.progress} percent.`
        : `Restored a cancelled submission that stopped at ${snap.progress} percent.`,
    );
    setStatusMessage(
      `Progress restored from ${formatTime(snap.savedAt)}. Your submission stopped at ${snap.progress} percent${
        snap.fileName ? ` while sending ${snap.fileName}` : ""
      }. Check your details and use Retry submission to send it again.`,
    );
    requestAnimationFrame(() => progressRef.current?.focus());
  }, [open]);




  const startAnotherApplication = () => {
    setReviewing(false);
    setNeedsReconfirm(false);
    setReceiptSent(false);
    setReference(null);
    setSendPhase("idle");
    setSendProgress(0);
    setSendStatus("");
    setArtist("");
    setEmail("");
    setPkg(defaultPackage);
    setFile(null);
    setUploadState("idle");
    setUploadProgress(0);
    setUploadStatus("");

    setLink("");
    setNotes("");
    setAck(false);
    setErrors({});
    setShowSummary(false);
    setSubmitted(false);
    setSubmitFailure(null);
    setStatusMessage(
      "New blank application form ready. All previous answers cleared. Focus moved to the first field, Artist or Band Name.",
    );
    if (fileInputRef.current) fileInputRef.current.value = "";
    setRefocusForm((n) => n + 1);
  };

  // Submit-another resets the form, so return focus to the first field once the
  // blank form has rendered (announced via the live status region above).
  useEffect(() => {
    if (refocusForm === 0) return;
    const t = requestAnimationFrame(() => {
      firstFieldRef.current?.focus();
      firstFieldRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(t);
  }, [refocusForm]);





  useEffect(
    () => () => {
      if (redirectTimerRef.current !== null) window.clearTimeout(redirectTimerRef.current);
    },
    [],
  );

  // Keyboard + screen-reader modal behaviour:
  // Escape closes, Tab is trapped inside the dialog, focus lands on the
  // dialog when it opens and returns to the opener when it closes, and the
  // rest of the page is hidden from assistive tech while it is open.
  useEffect(() => {
    if (!open || inline) return;

    const opener = document.activeElement as HTMLElement | null;
    openerRef.current = opener && opener !== document.body ? opener : null;

    const getFocusable = () => {
      const root = dialogRef.current;
      if (!root) return [] as HTMLElement[];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resetAndCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Keep focus inside even if something outside steals it (e.g. an iframe).
    const onFocusIn = (e: FocusEvent) => {
      const root = dialogRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) {
        const items = getFocusable();
        (items[0] ?? root).focus();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);

    const hidden: HTMLElement[] = [];
    Array.from(document.body.children).forEach((child: Element) => {
      const el = child as HTMLElement;
      if (el.contains(dialogRef.current) || el.getAttribute("aria-hidden") === "true") return;
      el.setAttribute("aria-hidden", "true");
      hidden.push(el);
    });

    const raf = requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      hidden.forEach((el) => el.removeAttribute("aria-hidden"));
      const opener2 = openerRef.current;
      if (opener2 && document.contains(opener2)) {
        requestAnimationFrame(() => opener2.focus());
      }
    };
  }, [open, inline]);



  const resetAndClose = () => {
    onClose();
    setTimeout(() => {
      setReviewing(false);
      setNeedsReconfirm(false);
      setSendPhase("idle");
      setSendProgress(0);
      setSendStatus("");
      setArtist("");
      setEmail("");
      setPkg(defaultPackage);
      setFile(null);
      setUploadState("idle");
      setUploadProgress(0);
      setUploadStatus("");
      revokePreview();
      setFileMeta(null);

      setLink("");
      setNotes("");
      setAck(false);
      setErrors({});
      setShowSummary(false);
      setStatusMessage("");
      setSubmitted(false);
      setSubmitFailure(null);
      setSubmitting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }, 200);
  };
  resetAndCloseRef.current = resetAndClose;


  const clearError = (name: FieldName) =>
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

  const validateField = (name: FieldName, value: string) => {
    const shape = applicationSchema.shape as Record<string, z.ZodTypeAny>;
    const schema = shape[name];
    if (!schema) return;
    const result = schema.safeParse(value);
    setErrors((prev) => ({
      ...prev,
      [name]: result.success ? undefined : result.error.issues[0]?.message,
    }));
  };

  const rejectFile = (message: string) => {
    setErrors((prev) => ({ ...prev, file: message }));
    setFile(null);
    revokePreview();
    setFileMeta(null);
    setUploadState("error");
    setUploadProgress(0);
    setUploadStatus(`File not accepted. ${message}`);
    setStatusMessage(`File not accepted. ${message}`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const processFile = async (f: File | null) => {
    clearError("file");

    if (!f) {
      setFile(null);
      setUploadState("idle");
      setUploadProgress(0);
      setUploadStatus("");
      revokePreview();
      setFileMeta(null);
      setStatusMessage("File removed. No attachment selected.");
      return;
    }

    const problem = validateFile(f);
    if (problem) {
      rejectFile(problem);
      return;
    }

    // Read the file in chunks so we can report real progress, and so unreadable
    // files (moved, renamed, still syncing from cloud storage) fail here rather
    // than silently at submit time.
    setFile(null);
    setUploadState("reading");
    setUploadProgress(0);
    setUploadStatus(`Attaching ${f.name}. 0 percent complete.`);
    setStatusMessage(`Attaching ${f.name}…`);

    const CHUNK = 1024 * 1024; // 1 MB
    let announced = 0;
    try {
      for (let offset = 0; offset < f.size || offset === 0; offset += CHUNK) {
        await f.slice(offset, Math.min(offset + CHUNK, f.size)).arrayBuffer();
        const pct = f.size === 0 ? 100 : Math.min(100, Math.round(((offset + CHUNK) / f.size) * 100));
        setUploadProgress(pct);
        // Announce at 25% milestones only, so the live region stays readable.
        if (pct >= announced + 25 && pct < 100) {
          announced = Math.floor(pct / 25) * 25;
          setUploadStatus(`Attaching ${f.name}. ${announced} percent complete.`);
        }
        // Yield so the progress bar repaints between chunks.
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch {
      rejectFile(
        `We couldn't read "${f.name}". It may have been moved, renamed, or is still syncing from cloud storage. Make sure the file is downloaded locally, then upload it again.`,
      );
      return;
    }

    setFile(f);
    setUploadProgress(100);
    setUploadState("done");

    const ext = getExt(f.name);
    const formatLabel = FORMAT_LABELS[ext] ?? `${ext.toUpperCase()} file`;
    const audio = isAudioFile(f.name);
    const previewUrl = audio ? URL.createObjectURL(f) : null;
    revokePreview();
    previewUrlRef.current = previewUrl;

    const baseMeta: FileMeta = {
      name: f.name,
      formatLabel,
      sizeLabel: formatMB(f.size),
      sizeBytes: f.size,
      typeLabel: f.type || `${audio ? "Audio" : "Document"} (${ext.toUpperCase()})`,
      isAudio: audio,
      previewUrl,
      durationSeconds: null,
      durationError: null,
    };
    setFileMeta(baseMeta);

    const done = `Upload complete. ${f.name} attached. Format ${formatLabel}, detected type ${baseMeta.typeLabel}, size ${formatMB(f.size)}. File details are listed in the uploaded file summary below the upload area.`;
    setUploadStatus(audio ? `${done} Reading audio length…` : done);
    setStatusMessage(done);

    if (audio && previewUrl) {
      const duration = await probeAudioDuration(previewUrl);
      if (previewUrlRef.current !== previewUrl) return; // superseded by another file
      if (duration) {
        setFileMeta({ ...baseMeta, durationSeconds: duration });
        const msg = `${done} Duration ${spokenDuration(duration)}. A local audio preview player is available below the upload area.`;
        setUploadStatus(msg);
        setStatusMessage(msg);
      } else {
        const err = "We couldn't read the audio length from this file, but it is still attached and will be submitted.";
        setFileMeta({ ...baseMeta, durationError: err });
        setUploadStatus(`${done} ${err}`);
        setStatusMessage(`${done} ${err}`);
      }
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    void processFile(e.target.files?.[0] ?? null);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const onDropzoneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      openFilePicker();
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!isDragging) {
      setIsDragging(true);
      setUploadStatus("File detected over the upload area. Release to attach it.");
    }
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Ignore drags moving between child elements of the dropzone.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (isDragging) {
      setIsDragging(false);
      setUploadStatus("Left the upload area. No file attached.");
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0] ?? null;
    if (!dropped) {
      setUploadStatus("Nothing was dropped. Try again, or use the Browse files button.");
      return;
    }
    if (e.dataTransfer.files.length > 1) {
      setUploadStatus("Multiple files dropped. Only the first file will be attached.");
    }
    void processFile(dropped);
  };


  const removeFile = () => {
    setFile(null);
    revokePreview();
    setFileMeta(null);
    setUploadState("idle");
    setUploadProgress(0);
    clearError("file");
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadStatus("Attachment removed. No file selected.");
    setStatusMessage("Attachment removed. No file selected.");
  };




  const validateAll = (): Errors => {
    const next: Errors = {};
    const result = applicationSchema.safeParse({ artist, email, pkg, link, notes });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[0] as FieldName;
        if (key && !next[key]) next[key] = issue.message;
      }
    }
    if (needsAck && !ack) {
      next.ack = "You must acknowledge the video rendering policy before submitting.";
    }
    return next;
  };

  // Report step completion outward so a flow progress indicator can only
  // advance once the required fields for the details step actually pass.
  const FIELD_LABELS: Record<string, string> = {
    artist: "Artist or band name",
    email: "Email address",
    pkg: "Package",
    link: "Track link",
    notes: "Notes",
    ack: "Video rendering acknowledgement",
  };
  useEffect(() => {
    if (!onProgressChange) return;
    const found = applicationSchema.safeParse({ artist, email, pkg, link, notes });
    const missing: string[] = [];
    if (!found.success) {
      for (const issue of found.error.issues) {
        const key = String(issue.path[0] ?? "");
        const label = FIELD_LABELS[key] ?? key;
        if (label && !missing.includes(label)) missing.push(label);
      }
    }
    if (needsAck && !ack) missing.push(FIELD_LABELS.ack);
    onProgressChange({ detailsComplete: missing.length === 0, submitted, missing });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, email, pkg, link, notes, ack, needsAck, submitted, onProgressChange]);


  const focusFirstError = (errs: Errors) => {
    const order: FieldName[] = ["artist", "email", "pkg", "file", "link", "notes", "ack"];
    const first = order.find((k) => errs[k]);
    if (!first) return;
    const el = document.getElementById(fid(first)) as HTMLElement | null;
    el?.focus();
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  // Inline receipt preview: a blob URL of the generated PDF shown on success.
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [branding, setBranding] = useState<ReceiptBranding>(DEFAULT_BRANDING);
  useEffect(() => setBranding(readBranding()), []);

  const [receiptName, setReceiptName] = useState<string | null>(null);
  const receiptUrlRef = useRef<string | null>(null);
  const [pdfMessage, setPdfMessage] = useState(
    "Receipts are generated on your device — nothing extra is uploaded.",
  );

  type StageTimes = {
    started?: string;
    recorded?: string;
    delivered?: string;
    confirmed?: string;
  };
  const [stageTimes, setStageTimes] = useState<StageTimes>({});

  const STAGE_LABELS: Array<{ key: keyof StageTimes; label: string }> = [
    { key: "started", label: "Submission started" },
    { key: "recorded", label: "Request recorded" },
    { key: "delivered", label: "Delivered to label" },
    { key: "confirmed", label: "Confirmed" },
  ];

  // Shared receipt payload used by both the PDF and JSON downloads.
  const buildReceiptData = (overrides?: { reference?: string | null }) => {
    const attachment = fileMeta
      ? {
          name: fileMeta.name,
          sizeLabel: `${fileMeta.sizeLabel} (${fileMeta.sizeBytes.toLocaleString()} bytes)`,
          sizeBytes: fileMeta.sizeBytes,
          typeLabel: fileMeta.typeLabel,
          formatLabel: fileMeta.formatLabel,
          durationSeconds: fileMeta.durationSeconds ?? null,
          durationLabel: fileMeta.durationSeconds
            ? formatDuration(fileMeta.durationSeconds)
            : fileMeta.isAudio
              ? "Unavailable"
              : "Not applicable",
        }
      : file
        ? {
            name: file.name,
            sizeLabel: formatMB(file.size),
            sizeBytes: file.size,
            typeLabel: file.type || "Unknown",
            formatLabel: getExt(file.name).toUpperCase(),
            durationSeconds: null,
            durationLabel: "Not applicable",
          }
        : null;

    const timeline = STAGE_LABELS.filter((s) => stageTimes[s.key]).map((s) => ({
      stage: s.key,
      label: s.label,
      at: stageTimes[s.key] as string,
    }));

    return {
      reference: overrides?.reference ?? reference,
      artist: artist.trim(),
      email: email.trim(),
      packageLabel: PACKAGE_OPTIONS.find((o) => o.value === pkg)?.label ?? pkg,
      link: link.trim(),
      notes: notes.trim(),
      acknowledged: needsAck ? ack : true,
      attachment,
      timeline,
    };
  };

  const receiptSlug = () =>
    (reference || artist.trim() || "application")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "application";

  // Downloads a machine-readable JSON receipt of the submission.
  const downloadReceiptJson = () => {
    try {
      const data = buildReceiptData();
      const payload = {
        document: "Hybrid AI Records — track submission receipt",
        generatedAt: new Date().toISOString(),
        ...data,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const filename = `hybrid-ai-records-receipt-${receiptSlug()}.json`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPdfMessage(`JSON receipt downloaded as ${filename}.`);
    } catch (err) {
      console.error("Receipt JSON failed:", err);
      setPdfMessage(
        `We couldn't build the JSON receipt in this browser. Email ${SUPPORT_EMAIL} and we'll send you a copy.`,
      );
    }
  };

  /* ---- Support hand-off: prefilled email + copyable diagnostics ---- */

  const [copyMessage, setCopyMessage] = useState("");
  const [copyRefMessage, setCopyRefMessage] = useState("");

  const diagnosticsText = () =>
    [
      "Hybrid AI Records — submission problem report",
      `When: ${new Date().toLocaleString()}`,
      `Artist / band: ${artist.trim() || "—"}`,
      `Reply-to email: ${email.trim() || "—"}`,
      `Package: ${PACKAGE_OPTIONS.find((o) => o.value === pkg)?.label ?? pkg}`,
      `Reference code: ${reference ?? "not issued"}`,
      `Attachment: ${file ? `${file.name} (${formatMB(file.size)})` : "none"}`,
      `External link: ${link.trim() || "—"}`,
      `Failed attempts: ${attempts}`,
      `Error: ${submitFailure?.title ?? "Unknown"}`,
      `Details: ${submitFailure?.detail ?? "—"}`,
      `HTTP status: ${submitFailure?.status ?? "—"}`,
      `Technical error: ${submitFailure?.raw ?? "—"}`,
    ].join("\n");

  const supportMailto = () =>
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
      `Submission problem — ${submitFailure?.title ?? "Track application"}${
        reference ? ` (${reference})` : ""
      }`,
    )}&body=${encodeURIComponent(`${diagnosticsText()}\n\nWhat I was doing:\n`)}`;

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsText());
      setCopyMessage("Diagnostics copied to your clipboard — paste them into your email to us.");
    } catch {
      setCopyMessage(
        `Copying isn't allowed in this browser. Email ${SUPPORT_EMAIL} and describe what happened.`,
      );
    }
  };

  const copyReference = async () => {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setCopyRefMessage("Reference code copied to your clipboard.");
    } catch {
      setCopyRefMessage("Copying isn't allowed in this browser — select the code and copy it.");
    }
  };

  const copyRawError = async () => {
    try {
      await navigator.clipboard.writeText(submitFailure?.raw ?? "No technical detail captured.");
      setCopyMessage("Technical error message copied to your clipboard.");
    } catch {
      setCopyMessage(
        `Copying isn't allowed in this browser. Select the text below and copy it manually.`,
      );
    }
  };




  // Builds the receipt PDF client-side and returns the jsPDF doc + filename.
  const makeReceiptPdf = async (overrides?: { reference?: string | null }) => {
    {
      const { buildApplicationPdf } = await import("@/lib/application-pdf");
      const data = buildReceiptData(overrides);
      const { doc, filename } = buildApplicationPdf({
        reference: data.reference,
        artist: data.artist,
        email: data.email,
        packageLabel: data.packageLabel,
        link: data.link,
        notes: data.notes,
        acknowledged: data.acknowledged,
        attachment: data.attachment
          ? {
              name: data.attachment.name,
              sizeLabel: data.attachment.sizeLabel,
              typeLabel: data.attachment.typeLabel,
              formatLabel: data.attachment.formatLabel,
              durationLabel: data.attachment.durationLabel,
            }
          : null,
        timeline: data.timeline.map((t) => ({
          label: t.label,
          at: new Date(t.at).toLocaleString(),
        })),
        submittedAt: new Date(),
        branding,

      });

      return { doc, filename };
    }
  };

  // Renders the receipt as soon as the submission succeeds so the artist can
  // read it on screen before downloading a copy.
  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    setPdfBusy(true);
    setPdfMessage("Preparing your receipt…");
    void (async () => {
      try {
        const { doc, filename } = await makeReceiptPdf();
        const blob = doc.output("blob") as Blob;
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (receiptUrlRef.current) URL.revokeObjectURL(receiptUrlRef.current);
        receiptUrlRef.current = url;
        setReceiptUrl(url);
        setReceiptName(filename);
        setPdfMessage("Your receipt is ready — preview it below or download a copy.");
      } catch (err) {
        console.error("Receipt preview failed:", err);
        if (!cancelled)
          setPdfMessage(
            `We couldn't render the receipt preview in this browser. Use the download buttons, or email ${SUPPORT_EMAIL} for a copy.`,
          );
      } finally {
        if (!cancelled) setPdfBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, branding]);


  useEffect(
    () => () => {
      if (receiptUrlRef.current) URL.revokeObjectURL(receiptUrlRef.current);
    },
    [],
  );

  // Downloads the receipt PDF, reusing the already-rendered preview when there.
  const downloadRecapPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    setPdfMessage("Preparing your PDF summary…");
    try {
      if (receiptUrl && receiptName) {
        const a = document.createElement("a");
        a.href = receiptUrl;
        a.download = receiptName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setPdfMessage(`PDF receipt downloaded as ${receiptName}. Check your downloads folder.`);
        return;
      }
      const { doc, filename } = await makeReceiptPdf();
      doc.save(filename);
      setPdfMessage(`PDF summary downloaded as ${filename}. Check your downloads folder.`);
    } catch (err) {
      console.error("Recap PDF failed:", err);
      setPdfMessage(
        `We couldn't build the PDF in this browser. Take a screenshot of this recap, or email ${SUPPORT_EMAIL} and we'll send you a copy.`,
      );
    } finally {
      setPdfBusy(false);
    }
  };


  const formRef = useRef<HTMLFormElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const retriedRef = useRef(false);

  // Jumps from the Final review recap back to a single field without leaving
  // the review step — the confirmation panel stays open and mounted.
  const editFromReview = (field: FieldName, label: string) => {
    const target =
      field === "file"
        ? (fileInputRef.current as HTMLElement | null) ??
          document.getElementById(fid(field))
        : document.getElementById(fid(field));
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    requestAnimationFrame(() => {
      (target as HTMLElement).focus({ preventScroll: true });
    });
    setStatusMessage(
      `Editing ${label}. Your final review is still open below — return to it and choose Confirm and submit when you are done.`,
    );
  };



  // Re-initiates the failed transfer with the same answers and attachment.
  // Keeps the progress panel mounted and resets the milestone list to stage 1
  // so the retry reads as a fresh run instead of resuming a broken one.
  const retryUpload = () => {
    if (submitting) return;
    retriedRef.current = true;
    setSubmitFailure(null);
    logActivity("Preparing your application", "Retry requested — restarting the send.", "warn");
    setSendPhase("sending");
    setResumedAt(null);
    setSendProgress(0);
    setStatusMessage(
      file
        ? `Retrying upload of ${file.name}. Progress milestones reset — sending your application again.`
        : "Retrying. Progress milestones reset — sending your application again.",
    );
    setSendStatus(
      file
        ? `Retrying upload of ${file.name}. Upload 0 percent complete.`
        : "Retrying submission of your application. Upload 0 percent complete.",
    );
    setReviewing(true);
    setNeedsReconfirm(false);
    requestAnimationFrame(() => {
      progressRef.current?.focus();
      formRef.current?.requestSubmit();
    });
  };



  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitFailure(null);

    const found = validateAll();
    setErrors(found);
    const count = Object.keys(found).length;
    if (count > 0) {
      setShowSummary(true);
      setStatusMessage(
        `${count} ${count === 1 ? "field needs" : "fields need"} your attention before this application can be submitted.`,
      );
      // Move focus to the summary so screen readers land on the problem list.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setShowSummary(false);

    // Spam / bot gate: hidden-field trap, human-speed check, and per-device
    // rate limiting. Runs before anything leaves the browser.
    const verdict = checkBotSignals({
      honeypot,
      startedAt: startedAtRef.current,
      history: readSubmitHistory(),
    });
    if (!verdict.ok) {
      setGuardError(verdict.message);
      setStatusMessage(verdict.message);
      requestAnimationFrame(() => guardRef.current?.focus());
      return;
    }
    setGuardError(null);

    // Final review step: nothing is sent until the artist confirms the recap.
    if (!reviewing) {
      setReviewing(true);
      setNeedsReconfirm(false);
      setStatusMessage(
        "Final review. Check your track details and attachment below, then choose Confirm and submit.",
      );
      requestAnimationFrame(() => reviewRef.current?.focus());
      return;
    }

    setSubmitting(true);
    const attempt = attempts + 1;
    setAttempts(attempt);
    setStatusMessage("Sending your application, please wait.");
    setSendPhase("sending");
    setResumedAt(null);
    setSendProgress(0);
    setStageTimes({ started: new Date().toISOString() });
    setActivity([]);
    logActivity(
      "Preparing your application",
      file
        ? `Packaging your answers and ${file.name} (${formatMB(file.size)}).`
        : "Packaging your answers for delivery.",
    );


    setSendStatus(
      file
        ? `Upload started. Sending your application and the attached file ${file.name}.`
        : "Upload started. Sending your application.",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    try {
      // Announce upload milestones while the request is in flight. The server
      // fn gives no byte-level progress, so we pace an estimate to the timeout
      // and snap to 100% the moment the send resolves.
      let announced = 0;
      ticker = setInterval(() => {
        setSendProgress((prev) => {
          const next = Math.min(prev + 3, 92);
          const milestone = Math.floor(next / 25) * 25;
          if (milestone > announced && milestone > 0 && milestone < 100) {
            announced = milestone;
            setSendStatus(`Upload ${milestone} percent complete.`);
            logActivity(
              milestone >= 75
                ? "Delivering to the Hybrid team"
                : milestone >= 50
                  ? "Uploading your answers"
                  : "Preparing your application",
              `Transfer reached ${milestone}%.`,
            );
          }
          return next;
        });
      }, 400);
      const packageLabel =
        PACKAGE_OPTIONS.find((o) => o.value === pkg)?.label ?? pkg;
      // The server fn has no abort signal, so we cap the wait ourselves and
      // report a timeout instead of leaving the artist on a spinner forever.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SubmitTimeoutError()), SUBMIT_TIMEOUT_MS);
      });
      // Lets the artist abandon an in-flight submission without waiting for the
      // 30 second timeout.
      const cancelled = new Promise<never>((_, reject) => {
        cancelSubmitRef.current = () => reject(new SubmitCancelledError());
      });
      // Record the request first so the artist gets a trackable reference
      // code inside the confirmation email. A failure here must not block the
      // submission itself.
      let refCode: string | null = null;
      try {
        const created = (await Promise.race([
          createRequest({
            data: {
              artist: artist.trim(),
              email: email.trim(),
              packageLabel,
              fileName: file?.name ?? null,
              link: link.trim() || null,
              notes: notes.trim() || null,
              acknowledged: needsAck ? ack : true,
            },
          }),
          cancelled,
        ])) as { ok: boolean; reference: string | null } | undefined;
        refCode = created?.reference ?? null;
      } catch (err) {
        if (err instanceof SubmitCancelledError) throw err;
        console.error("Track request record failed:", err);
      }
      setReference(refCode);
      logActivity(
        "Uploading your answers",
        refCode
          ? `Request recorded. Reference code ${refCode} issued.`
          : "Request recorded, but no reference code was issued — your submission still goes through.",
        refCode ? "ok" : "warn",
      );
      setStageTimes((p) => ({ ...p, recorded: new Date().toISOString() }));


      // Build the receipt PDF now so it can ride along with the confirmation
      // email. A rendering failure must never block the submission.
      let receiptPdfBase64: string | null = null;
      let receiptPdfName: string | null = null;
      try {
        const { doc, filename } = await makeReceiptPdf({ reference: refCode });
        receiptPdfBase64 = (doc.output("datauristring") as string).split(",")[1] ?? null;
        receiptPdfName = filename;
      } catch (err) {
        console.error("Receipt PDF for email failed:", err);
        logActivity(
          "Confirming and emailing your receipt",
          "Receipt PDF could not be generated — the confirmation email will be sent without it.",
          "warn",
        );
      }

      // The submission is already recorded above, so an email hiccup must never
      // tell the artist their application failed. Cancellation still aborts.
      let sendResult: { ok: boolean; receiptSent?: boolean } | undefined;
      try {
        sendResult = (await Promise.race([
          sendEmail({
            data: {
              artist: artist.trim(),
              email: email.trim(),
              packageLabel,
              fileName: file?.name ?? null,
              link: link.trim() || null,
              notes: notes.trim() || null,
              acknowledged: needsAck ? ack : true,
              reference: refCode,
              statusUrl: refCode
                ? `${window.location.origin}/order-status?ref=${encodeURIComponent(refCode)}`
                : null,
              receiptPdfBase64,
              receiptPdfName,
            },
          }),
          timeout,
          cancelled,
        ])) as { ok: boolean; receiptSent?: boolean } | undefined;
      } catch (err) {
        if (err instanceof SubmitCancelledError) throw err;
        if (!refCode) throw err;
        console.error("Application email failed:", err);
        sendResult = { ok: false, receiptSent: false };
      }
      const gotReceipt = Boolean(sendResult?.receiptSent);
      const delivered = Boolean(sendResult?.ok);
      logActivity(
        "Delivering to the Hybrid team",
        delivered
          ? "Application delivered."
          : `Saved with reference ${refCode}. Email notification is delayed — the team still sees your submission.`,
        delivered ? "ok" : "warn",
      );
      logActivity(
        "Confirming and emailing your receipt",
        gotReceipt
          ? `Confirmation receipt${receiptPdfBase64 ? " with PDF attached" : ""} emailed to ${email.trim()}.`
          : "Saved, but the confirmation email could not be sent.",
        gotReceipt ? "ok" : "warn",
      );

      setReceiptSent(gotReceipt);
      setSendProgress(100);
      setSendPhase("done");
      setConfirmCancel(false);
      setStageTimes((p) => {
        const now = new Date().toISOString();
        return { ...p, delivered: now, confirmed: now };
      });

      setSendStatus(
        retriedRef.current
          ? "Retry successful. Upload 100 percent complete. Your application was sent."
          : "Upload 100 percent complete. Your application was sent successfully.",
      );
      retriedRef.current = false;
      removeDraft(draftScope);
      clearHistory(draftScope);
      setHistoryTick((t) => t + 1);
      const ownerKey = readOwnerKey(email.trim());
      if (ownerKey) {
        void clearCloud({ data: { email: email.trim(), ownerKey } }).catch(() => undefined);
      }
      setDraftRestored(false);
      setDraftSavedAt(null);
      setDraftStatus("");
      setCloudState("idle");
      setCloudSavedAt(null);
      setResumeState("idle");
      setAttempts(0);
      setReviewing(false);
      setNeedsReconfirm(false);
      // Keep a local, searchable record of this submission for /receipts.
      try {
        recordReceipt({
          ...buildReceiptData({ reference: refCode }),
          submittedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Receipt history save failed:", err);
      }
      recordSubmit();
      setSubmitted(true);
      // Hand the artist straight to their live status page with a confirmation.
      if (refCode) {
        const target = `/order-status?ref=${encodeURIComponent(refCode)}&email=${encodeURIComponent(
          email.trim(),
        )}`;
        redirectTimerRef.current = window.setTimeout(() => {
          window.location.assign(target);
        }, 1800);
      }
      setStatusMessage(
        gotReceipt
          ? `Application received. A confirmation receipt was emailed to ${email.trim()}.`
          : "Application received. The Hybrid team will review it shortly. The confirmation receipt email could not be sent, but your submission is safe.",
      );
    } catch (err) {
      console.error(err);
      const cancelledByUser = err instanceof SubmitCancelledError;
      setSendPhase(cancelledByUser ? "cancelled" : "error");
      setConfirmCancel(false);
      logActivity(
        "Delivering to the Hybrid team",
        cancelledByUser
          ? "You cancelled the upload — nothing was sent."
          : `Submission stopped: ${rawErrorText(err).split("\n")[0]}`,
        cancelledByUser ? "warn" : "error",
      );
      setSendStatus(
        cancelledByUser
          ? "Upload cancelled. Nothing was sent — your answers are still here."
          : "Upload failed. Your application was not sent.",
      );
      const failure = {
        ...classifySubmitFailure(err, attempt),
        raw: rawErrorText(err),
        status:
          typeof err === "object" && err !== null && "status" in err
            ? Number((err as { status?: unknown }).status)
            : undefined,
      };
      setSubmitFailure(failure);
      // Link the failure to the field that caused it so it shows inline and in
      // the error summary, exactly like a client-side validation error.
      if (failure.field) {
        setErrors((prev) => ({ ...prev, [failure.field as FieldName]: failure.title }));
        setShowSummary(true);
      }
      setStatusMessage(
        `${retriedRef.current ? "Retry failed." : "Submission failed."} ${failure.title}. ${failure.detail} ${failure.steps.join(" ")}${
          failure.retryable ? " A Retry upload button is available in the error panel." : ""
        }`,
      );
      requestAnimationFrame(() => {
        if (retriedRef.current && failure.retryable && retryRef.current) retryRef.current.focus();
        else failureRef.current?.focus();
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      cancelSubmitRef.current = null;
      setSubmitting(false);
    }
  };

  // First press only asks; the confirm button below actually stops the run.
  const requestCancel = () => {
    if (!cancelSubmitRef.current) return;
    setConfirmCancel(true);
    setStatusMessage(
      "Confirm cancel: stopping now discards this upload. Choose Yes, stop upload or Keep uploading.",
    );
  };

  const dismissCancel = () => {
    setConfirmCancel(false);
    setStatusMessage("Cancel dismissed. Your upload is still running.");
  };

  const cancelSubmit = () => {
    setConfirmCancel(false);
    if (!cancelSubmitRef.current) return;
    // Announce immediately so the stop is confirmed before the request unwinds.
    setSendStatus("Cancelling upload…");
    logActivity("Delivering to the Hybrid team", "Cancel requested…", "warn");
    setStatusMessage("Cancelling the upload. Nothing will be sent.");
    cancelSubmitRef.current();
  };



  if (!open) return null;

  const errorEntries = (Object.entries(errors) as [FieldName, string | undefined][]).filter(
    ([, v]) => Boolean(v),
  );

  return (
    <div
      ref={dialogRef}
      tabIndex={inline ? undefined : -1}
      role={inline ? "region" : "dialog"}
      aria-modal={inline ? undefined : "true"}
      aria-labelledby={fid("title")}
      aria-describedby={fid("intro")}
      className={
        inline
          ? "w-full outline-none"
          : "fixed inset-0 z-[110] flex h-[100dvh] items-stretch justify-center overflow-y-auto overscroll-contain overlay-scrim bg-foreground/40 outline-none backdrop-blur-md ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] sm:items-start sm:p-8"
      }
      onClick={inline ? undefined : resetAndClose}
    >
      <div
        className={
          inline
            ? "relative w-full border border-border-strong bg-background/60 text-foreground backdrop-blur-sm"
            : "relative w-full min-h-full border-0 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground shadow-[var(--shadow-hard)] sm:my-auto sm:min-h-0 sm:max-w-2xl sm:border sm:border-border-strong sm:py-0"
        }
        onClick={inline ? undefined : (e) => e.stopPropagation()}
      >
        {!inline && (
          <button
            type="button"
            onClick={resetAndClose}
            className="absolute end-3 top-[calc(0.75rem+env(safe-area-inset-top))] z-10 grid h-11 w-11 place-items-center border border-border bg-background/80 text-foreground transition-colors hover:border-primary hover:text-primary sm:top-3 sm:h-10 sm:w-10"
            aria-label="Close application"
          >
            <X size={18} />
          </button>
        )}

        {/* Polite live region: announces validation, upload and submit status. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {statusMessage}
        </div>

        {/* Polite live region: announces draft autosave / restore / discard. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {draftStatus}
        </div>

        {/* Polite live region: announces upload progress milestones and completion. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {uploadStatus}
        </div>

        {/* Assertive live region: submit-time upload progress, completion, cancel and errors. */}
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {sendStatus}
        </div>



        {submitted ? (
          <div
            ref={successRef}
            tabIndex={-1}
            role="status"
            className="overflow-y-auto overscroll-contain px-6 py-10 focus-visible:outline-none sm:max-h-[85dvh] sm:px-10"
          >
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-full border border-[#4b8bff] text-[#4b8bff]">
                <CheckCircle2 size={28} aria-hidden="true" />
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                <span className="text-[#e11d2e]">/</span> Application received
              </div>
              <h2 id={fid("title")} className="font-display text-2xl font-semibold sm:text-3xl">
                Thank you, {artist.trim() || "artist"} — your project is in review
              </h2>
              <p id={fid("intro")} className="max-w-md text-sm text-muted-foreground sm:text-base">
                No payment was taken today. We review every submission by hand and reply by email.
              </p>
              <p className="max-w-md text-sm sm:text-base">
                {receiptSent ? (
                  <>
                    <span className="text-[#4b8bff]">Confirmation receipt sent</span>{" "}
                    <span className="text-muted-foreground">
                      to <span className="break-all text-foreground">{email.trim()}</span> with your
                      receipt PDF attached, this summary and your next steps. Check spam if it is not in your inbox within a
                      few minutes.
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    We could not email your confirmation receipt, but your application was received.
                    The details below are your record — keep this window or take a screenshot.
                  </span>
                )}
              </p>
              {reference && (
                <div className="mt-2 w-full max-w-md border border-[#e11d2e]/60 bg-[#e11d2e]/5 p-4">
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Your reference code
                  </p>
                  <p className="mt-1 font-mono text-lg tracking-[0.16em] text-[#e11d2e]">
                    {reference}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Save this code. Use it with your email on the status page to see your recap and
                    production milestones.
                  </p>
                  <p className="mt-2 text-xs text-[#4b8bff]">
                    Taking you to your Order Status page now…
                  </p>
                  <a
                    href={`/order-status?ref=${encodeURIComponent(reference)}&email=${encodeURIComponent(email.trim())}`}
                    className="mt-3 inline-block border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    Open order status
                  </a>
                </div>
              )}
            </div>

            {/* What was submitted */}
            <div className="mt-8 border border-border bg-white/[0.02] p-5 text-start">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                What you submitted
              </h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">Artist:</dt>
                  <dd className="text-foreground">{artist.trim() || "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">Reply-to email:</dt>
                  <dd className="break-all text-foreground">{email.trim() || "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">Package:</dt>
                  <dd className="text-foreground">
                    {PACKAGE_OPTIONS.find((o) => o.value === pkg)?.label ?? pkg}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">Attachment:</dt>
                  <dd className="break-all text-foreground">{file?.name ?? "None attached"}</dd>
                </div>
              </dl>
            </div>

            {/* Next steps */}
            <div className="mt-6 text-start">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                What happens next
              </h3>
              <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
                <li className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center border border-[#e11d2e] font-mono text-[11px] text-[#e11d2e]"
                  >
                    1
                  </span>
                  <span>
                    <span className="text-foreground">Review (1–2 business days).</span> Our team
                    listens to your material and checks your lyrics against our content policy.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center border border-white/60 font-mono text-[11px] text-white"
                  >
                    2
                  </span>
                  <span>
                    <span className="text-foreground">Confirmation email.</span> If approved, we
                    email {email.trim() || "your address"} with your production slot and a payment
                    invoice. Check your spam folder if you don't see it.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center border border-[#4b8bff] font-mono text-[11px] text-[#4b8bff]"
                  >
                    3
                  </span>
                  <span>
                    <span className="text-foreground">Production begins.</span> Once the invoice is
                    paid, we start your track and keep you updated through each revision round.
                  </span>
                </li>
              </ol>
            </div>

            <p className="mt-6 text-start text-xs text-muted-foreground">
              Questions in the meantime? Email{" "}
              <a
                href="mailto:Hybrid.AI.Records@proton.me"
                className="text-[#4b8bff] underline underline-offset-4 hover:text-white"
              >
                Hybrid.AI.Records@proton.me
              </a>
              .
            </p>

            <div className="mt-8 border border-border-strong bg-white/[0.02] p-5 text-start">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Submission receipt
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Download your receipt — reference code, stage timestamps, project details and
                attachment metadata.
              </p>

              {(() => {
                const rows = STAGE_LABELS.filter((s) => stageTimes[s.key]);
                if (!rows.length) return null;
                return (
                  <dl className="mt-4 divide-y divide-border-strong border-y border-border-strong text-sm">
                    {rows.map((s) => (
                      <div key={s.key} className="flex justify-between gap-4 py-2">
                        <dt className="text-muted-foreground">{s.label}</dt>
                        <dd className="text-end text-white">
                          {new Date(stageTimes[s.key] as string).toLocaleString()}
                        </dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}

              <ReceiptBrandingPanel branding={branding} onChange={setBranding} />


              {receiptUrl && (
                <div className="mt-4 border border-border-strong bg-ink/40">
                  <div className="flex items-center justify-between gap-3 border-b border-border-strong px-3 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Receipt preview{reference ? ` · ${reference}` : ""}
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      {reference && (
                        <button
                          type="button"
                          onClick={copyReference}
                          className="inline-flex items-center gap-1.5 border border-border-strong px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
                        >
                          <Copy size={12} aria-hidden="true" />
                          Copy code
                        </button>
                      )}
                      <a
                        href={receiptUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fb6ff] underline underline-offset-4 hover:text-white"
                      >
                        Open in new tab
                      </a>
                    </div>
                  </div>
                  {copyRefMessage && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="border-b border-border-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8fb6ff]"
                    >
                      {copyRefMessage}
                    </p>
                  )}
                  <iframe
                    src={receiptUrl}
                    title="Submission receipt preview"
                    className="h-[420px] w-full bg-white"
                  />
                </div>
              )}

              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={downloadRecapPdf}
                  disabled={pdfBusy}
                  aria-busy={pdfBusy}
                  aria-describedby={fid("pdf-status")}
                  className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#4b8bff] px-5 py-2.5 text-xs font-semibold uppercase tracking-widest text-[#8fb6ff] transition-colors hover:bg-[#4b8bff]/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download size={15} aria-hidden="true" />
                  {pdfBusy ? "Preparing PDF…" : "Download receipt (PDF)"}
                </button>
                <button
                  type="button"
                  onClick={downloadReceiptJson}
                  aria-describedby={fid("pdf-status")}
                  className="inline-flex min-h-11 items-center justify-center gap-2 border border-border-strong px-5 py-2.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary hover:text-white"
                >
                  <Download size={15} aria-hidden="true" />
                  Download receipt (JSON)
                </button>
              </div>
              <p
                id={fid("pdf-status")}
                role="status"
                aria-live="polite"
                className="mt-2 text-xs text-muted-foreground"
              >
                {pdfMessage}
              </p>
            </div>


            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={resetAndClose}
                className="min-h-11 flex-1 bg-[#e11d2e] px-6 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-[#ff2b3d]"
              >
                Back to the site
              </button>
              <button
                type="button"
                onClick={startAnotherApplication}
                className="min-h-11 flex-1 border border-border-strong px-6 py-3 text-xs font-semibold uppercase tracking-widest text-foreground transition-colors hover:border-white hover:text-white"
              >
                Submit another project
              </button>
            </div>
          </div>

        ) : (
          <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            className="overflow-y-auto overscroll-contain sm:max-h-[85dvh]"
          >
            <div className="border-b border-border px-6 py-5 sm:px-8">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                <span className="text-[#e11d2e]">/</span> <span className="text-white">Artist</span>{" "}
                <span className="text-[#4b8bff]">Application</span>
              </div>
              <h2 id={fid("title")} className="mt-2 font-display text-xl font-semibold sm:text-2xl">
                Submit your project for review
              </h2>
              <p id={fid("intro")} className="mt-1 text-xs text-muted-foreground sm:text-sm">
                Once approved, we email your confirmation and payment invoice — no charge today.
                Fields marked with an asterisk are required.
              </p>
            </div>

            <div className="space-y-5 px-6 py-6 sm:px-8">
              {draftRestored && (
                <div className="flex flex-col gap-2 border border-[#4b8bff]/60 bg-[#4b8bff]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[#bcd4ff]">
                    Draft restored from{" "}
                    {draftSavedAt ? formatTime(draftSavedAt) : "your last visit"}. Any attached
                    file must be re-attached.
                  </p>
                  <button
                    type="button"
                    onClick={discardDraft}
                    className="self-start border border-[#4b8bff] px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#bcd4ff] transition-colors hover:bg-[#4b8bff] hover:text-black sm:self-auto"
                  >
                    Start fresh
                  </button>
                </div>
              )}

              {/* Roll back to an earlier autosaved version of this application. */}
              <DraftHistoryPanel
                scope={draftScope}
                refreshKey={historyTick}
                onRestore={restoreSnapshot}
              />



              {/* Cross-device draft sync controls. */}
              <div className="flex flex-col gap-3 border border-border bg-surface/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
                    Continue on another device
                  </p>
                  <p className="mt-1">
                    {cloudState === "syncing"
                      ? "Syncing your draft securely…"
                      : cloudState === "synced"
                        ? `Draft synced${cloudSavedAt ? ` at ${formatTime(cloudSavedAt)}` : ""}. We can email you a secure link to pick up where you left off.`
                        : cloudState === "error"
                          ? "Sync failed — your draft is still safe on this device and we'll retry as you type."
                          : "Add your contact email and we'll save your progress securely so you can finish on any device."}
                  </p>
                  {resumeState === "sent" && (
                    <p className="mt-1 text-[#7ee0a1]">Link sent — it expires in 24 hours.</p>
                  )}
                  {resumeState === "none" && (
                    <p className="mt-1 text-[#ffca6b]">No saved draft found for that email yet.</p>
                  )}
                  {resumeState === "error" && (
                    <p className="mt-1 text-[#ff9a9a]">
                      We couldn't send that link. Check the email address and try again.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={requestResumeLink}
                  disabled={resumeState === "sending"}
                  className="self-start whitespace-nowrap border border-border-strong px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60 sm:self-auto"
                >
                  {resumeState === "sending" ? "Sending…" : "Email me a resume link"}
                </button>
              </div>

              {/* Honeypot: visually hidden and off the tab order, so only bots fill it. */}
              <div aria-hidden="true" className="absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [clip-path:inset(50%)]">
                <label htmlFor={fid(HONEYPOT_FIELD)}>Company website (leave blank)</label>
                <input
                  id={fid(HONEYPOT_FIELD)}
                  name={HONEYPOT_FIELD}
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

              {guardError && (
                <div
                  ref={guardRef}
                  tabIndex={-1}
                  role="alert"
                  className="border border-[#e11d2e] bg-[#e11d2e]/10 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e]"
                >
                  <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ff6b78]">
                    <AlertCircle size={14} aria-hidden="true" />
                    Submission blocked
                  </div>
                  <p className="mt-2 text-xs text-[#ff9aa3]">{guardError}</p>
                </div>
              )}

              {showSummary && errorEntries.length > 0 && (
                <div
                  ref={summaryRef}
                  tabIndex={-1}
                  role="alert"
                  aria-labelledby={fid("summary-title")}
                  className="border border-[#e11d2e] bg-[#e11d2e]/10 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e]"
                >
                  <div
                    id={fid("summary-title")}
                    className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ff6b78]"
                  >
                    <AlertCircle size={14} aria-hidden="true" />
                    Please fix {errorEntries.length}{" "}
                    {errorEntries.length === 1 ? "field" : "fields"}
                  </div>
                  <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-[#ff9aa3]">
                    {errorEntries.map(([name, message]) => (
                      <li key={name}>
                        <a
                          href={`#${fid(name)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            document.getElementById(fid(name))?.focus();
                          }}
                          className="underline underline-offset-2"
                        >
                          {message}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Field
                id={fid("artist")}
                label="Artist / Band Name"
                required
                error={errors.artist}
                errorId={fid("artist-error")}
              >
                <input
                  ref={firstFieldRef}
                  id={fid("artist")}
                  name="artist"
                  type="text"
                  autoComplete="organization"
                  maxLength={100}
                  value={artist}
                  aria-required="true"
                  aria-invalid={errors.artist ? true : undefined}
                  aria-describedby={errors.artist ? fid("artist-error") : undefined}
                  onChange={(e) => {
                    setArtist(e.target.value);
                    clearError("artist");
                  }}
                  onBlur={(e) => validateField("artist", e.target.value)}
                  className={inputClass(!!errors.artist)}
                  placeholder="Your stage or band name"
                />
              </Field>

              <Field
                id={fid("email")}
                label="Email Address"
                required
                error={errors.email}
                errorId={fid("email-error")}
              >
                <input
                  id={fid("email")}
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={255}
                  value={email}
                  aria-required="true"
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? fid("email-error") : undefined}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearError("email");
                  }}
                  onBlur={(e) => validateField("email", e.target.value)}
                  className={inputClass(!!errors.email)}
                  placeholder="you@example.com"
                />
              </Field>

              <Field
                id={fid("pkg")}
                label="Selected Package"
                required
                error={errors.pkg}
                errorId={fid("pkg-error")}
              >
                <select
                  id={fid("pkg")}
                  name="pkg"
                  value={pkg}
                  aria-required="true"
                  aria-invalid={errors.pkg ? true : undefined}
                  aria-describedby={errors.pkg ? fid("pkg-error") : undefined}
                  onChange={(e) => {
                    setPkg(e.target.value);
                    clearError("pkg");
                    clearError("ack");
                  }}
                  className={inputClass(!!errors.pkg)}
                >
                  {PACKAGE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} className="bg-background">
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                id={fid("file")}
                label="Song / Lyric Submission"
                hint="MP3, WAV, M4A, AAC, FLAC, PDF, DOC, DOCX or TXT. Max 50 MB."
                hintId={fid("file-hint")}
                error={errors.file}
                errorId={fid("file-error")}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={openFilePicker}
                  onKeyDown={onDropzoneKeyDown}
                  onDragOver={onDragOver}
                  onDragEnter={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  aria-label={
                    file
                      ? `Attached file ${file.name}. Activate to replace it, or drop a file here.`
                      : "Upload your song or lyric file. Drag and drop a file here, or activate to browse files."
                  }
                  aria-describedby={`${fid("file-hint")} ${fid("file-dnd-hint")}${errors.file ? ` ${fid("file-error")}` : ""}`}
                  aria-invalid={errors.file ? true : undefined}
                  className={`flex cursor-pointer flex-col gap-2 border border-dashed px-4 py-5 text-sm transition-colors motion-reduce:transition-none hover:border-[#e11d2e] hover:bg-[#e11d2e]/10 ${
                    isDragging
                      ? "border-[#e11d2e] bg-[#e11d2e]/15"
                      : errors.file
                        ? "border-[#e11d2e] bg-background/40"
                        : "border-[#e11d2e]/60 bg-background/40"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Upload size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-muted-foreground">
                      {isDragging
                        ? "Drop the file to attach it"
                        : file
                          ? file.name
                          : "Drag & drop a file here"}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openFilePicker();
                      }}
                      className="min-h-11 border border-[#e11d2e]/60 px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition-colors hover:border-[#e11d2e] hover:bg-[#e11d2e]/20"
                    >
                      Browse files
                    </button>
                    <span id={fid("file-dnd-hint")} className="text-xs text-muted-foreground">
                      Or press Enter or Space to open your file browser.
                    </span>
                  </span>
                </div>
                <input
                  id={fid("file")}
                  name="file"
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_FILES}
                  onChange={onFileChange}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                />


                {/* Upload progress — exposed as a progressbar and announced politely. */}
                {(uploadState === "reading" || uploadState === "done") && (
                  <div id={fid("file-progress")} className="mt-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-muted-foreground">
                        {uploadState === "done" ? "Upload complete" : "Attaching file…"}
                      </span>
                      <span className="font-mono text-[11px] text-foreground">
                        {uploadProgress}%
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={uploadProgress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuetext={`${uploadProgress} percent ${uploadState === "done" ? "complete" : "attached"}`}
                      aria-label="File upload progress"
                      className="mt-1 h-2 w-full overflow-hidden border border-border bg-white/5"
                    >
                      <div
                        className={`h-full transition-[width] duration-200 motion-reduce:transition-none ${
                          uploadState === "done" ? "bg-[#4b8bff]" : "bg-[#e11d2e]"
                        }`}
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    {uploadState === "done" && file && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2 text-[#8fb6ff]">
                          <CheckCircle2 size={14} aria-hidden="true" />
                          <span className="break-all">
                            {file.name} · {formatMB(file.size)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={removeFile}
                          className="min-h-11 px-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground underline underline-offset-4 transition-colors hover:text-white"
                        >
                          Remove file
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {uploadState === "done" && fileMeta && (
                  <section
                    aria-labelledby={fid("meta-heading")}
                    className="mt-3 rounded-md border border-white/10 bg-ink/40 p-3"
                  >
                    <h4
                      id={fid("meta-heading")}
                      className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                    >
                      Uploaded file summary
                    </h4>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                      <div className="flex gap-2 sm:col-span-2">
                        <dt className="shrink-0 text-muted-foreground">Filename</dt>
                        <dd className="break-all text-white">{fileMeta.name}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Size</dt>
                        <dd className="text-white">
                          {fileMeta.sizeLabel} ({fileMeta.sizeBytes.toLocaleString()} bytes)
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Detected type</dt>
                        <dd className="break-all text-white">{fileMeta.typeLabel}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Format</dt>
                        <dd className="text-white">{fileMeta.formatLabel}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Duration</dt>
                        <dd className="text-white">
                          {fileMeta.durationSeconds
                            ? formatDuration(fileMeta.durationSeconds)
                            : fileMeta.isAudio
                              ? fileMeta.durationError
                                ? "Unavailable"
                                : "Reading…"
                              : "Not applicable"}
                        </dd>
                      </div>
                    </dl>
                    {fileMeta.durationError && (
                      <p className="mt-2 text-xs text-muted-foreground">{fileMeta.durationError}</p>
                    )}
                    {fileMeta.isAudio && fileMeta.previewUrl && (
                      <div className="mt-3">
                        <p
                          id={fid("preview-label")}
                          className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                        >
                          Local preview — plays from your device only
                        </p>
                        <audio
                          key={fileMeta.previewUrl}
                          src={fileMeta.previewUrl}
                          controls
                          preload="metadata"
                          aria-label={`Audio preview of ${fileMeta.name}`}
                          aria-describedby={fid("preview-label")}
                          className="mt-2 w-full"
                        />
                      </div>
                    )}
                  </section>
                )}



              </Field>

              <Field
                id={fid("link")}
                label="External Link to Demo / Cloud Folder"
                hint="Optional — Google Drive, Dropbox, SoundCloud, etc."
                hintId={fid("link-hint")}
                error={errors.link}
                errorId={fid("link-error")}
              >
                <input
                  id={fid("link")}
                  name="link"
                  type="url"
                  inputMode="url"
                  maxLength={500}
                  value={link}
                  aria-invalid={errors.link ? true : undefined}
                  aria-describedby={`${fid("link-hint")}${errors.link ? ` ${fid("link-error")}` : ""}`}
                  onChange={(e) => {
                    setLink(e.target.value);
                    clearError("link");
                  }}
                  onBlur={(e) => validateField("link", e.target.value)}
                  className={inputClass(!!errors.link)}
                  placeholder="https://"
                />
              </Field>

              <Field
                id={fid("notes")}
                label="Project Notes / Vision"
                hint={`${notes.length}/2000 characters`}
                hintId={fid("notes-hint")}
                error={errors.notes}
                errorId={fid("notes-error")}
              >
                <textarea
                  id={fid("notes")}
                  name="notes"
                  rows={4}
                  maxLength={2000}
                  value={notes}
                  aria-invalid={errors.notes ? true : undefined}
                  aria-describedby={`${fid("notes-hint")}${errors.notes ? ` ${fid("notes-error")}` : ""}`}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    clearError("notes");
                  }}
                  className={`${inputClass(!!errors.notes)} resize-y`}
                  placeholder="Tell us about the direction, references, mood, or goals for this project."
                />
              </Field>

              {needsAck && (
                <div>
                  <div
                    className={`flex items-start gap-3 border bg-background/40 p-4 text-sm ${
                      errors.ack ? "border-[#e11d2e]" : "border-border"
                    }`}
                  >
                    <input
                      id={fid("ack")}
                      name="ack"
                      type="checkbox"
                      checked={ack}
                      aria-required="true"
                      aria-invalid={errors.ack ? true : undefined}
                      aria-describedby={errors.ack ? fid("ack-error") : undefined}
                      onChange={(e) => {
                        setAck(e.target.checked);
                        clearError("ack");
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer appearance-none border border-border-strong bg-background/60 transition-colors checked:border-[#e11d2e] checked:bg-[#e11d2e] checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22none%22 stroke=%22white%22 stroke-width=%223%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><polyline points=%223 8 7 12 13 4%22/></svg>')] checked:bg-center checked:bg-no-repeat focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e]"
                    />
                    <label htmlFor={fid("ack")} className="cursor-pointer text-muted-foreground">
                      I acknowledge that video rendering is finalized upon completion and
                      non-refundable once rendering begins.
                    </label>
                  </div>
                  {errors.ack && (
                    <p id={fid("ack-error")} className="mt-1.5 text-xs text-[#ff6b78]">
                      {errors.ack}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 flex flex-col gap-3 border-t border-border bg-background/95 px-6 py-4 backdrop-blur-md sm:px-8">
              {submitFailure && (
                <div
                  ref={failureRef}
                  tabIndex={-1}
                  role="alert"
                  aria-labelledby={fid("submit-failure-title")}
                  className="border border-[#e11d2e]/70 bg-[#e11d2e]/10 p-4 outline-none"
                >
                  <p
                    id={fid("submit-failure-title")}
                    className="flex items-start gap-2 text-sm font-semibold text-[#ff6b78]"
                  >
                    <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {submitFailure.title}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {submitFailure.detail}
                  </p>
                  <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    How to fix it
                  </p>
                  <ol className="mt-1.5 list-decimal space-y-1 ps-5 text-xs leading-relaxed text-foreground">
                    {submitFailure.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  {submitFailure.field && (
                    <button
                      type="button"
                      onClick={() => {
                        const el = document.getElementById(
                          fid(submitFailure.field as FieldName),
                        ) as HTMLElement | null;
                        el?.scrollIntoView({ block: "center", behavior: "smooth" });
                        el?.focus();
                      }}
                      className="mt-3 min-h-11 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fb6ff] underline underline-offset-4 transition-colors hover:text-white"
                    >
                      Go to the field that needs attention
                    </button>
                  )}
                  {submitFailure.retryable && (
                    <button
                      type="button"
                      ref={retryRef}
                      onClick={retryUpload}
                      disabled={submitting}
                      aria-label={
                        file
                          ? `Retry upload of ${file.name} and resend your application`
                          : "Retry sending your application"
                      }
                      className="mt-4 inline-flex min-h-11 items-center gap-2 bg-[#e11d2e] px-5 py-2.5 text-xs font-semibold uppercase tracking-widest text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {submitting ? "Retrying…" : file ? "Retry upload" : "Retry sending"}
                    </button>
                  )}
                  {/* Contextual quick fixes for this specific error type. */}
                  {submitFailure.field === "file" && file && (
                    <button
                      type="button"
                      onClick={() => {
                        removeFile();
                        const el = document.getElementById(fid("link")) as HTMLElement | null;
                        el?.scrollIntoView({ block: "center", behavior: "smooth" });
                        el?.focus();
                      }}
                      className="mt-3 block min-h-11 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fb6ff] underline underline-offset-4 transition-colors hover:text-white"
                    >
                      Remove the attachment and use an external link instead
                    </button>
                  )}

                  {attempts > 1 && (
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      Failed attempts: {attempts}. Your answers stay saved on this device.
                    </p>
                  )}

                  {/* Expandable technical detail for anyone reporting the bug. */}
                  <details className="group mt-4 border border-border-strong bg-background/60">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-white">
                      <span>Error details</span>
                      <span aria-hidden="true" className="text-[#8fb6ff] group-open:hidden">
                        Show
                      </span>
                      <span aria-hidden="true" className="hidden text-[#8fb6ff] group-open:inline">
                        Hide
                      </span>
                    </summary>
                    <div className="border-t border-border-strong px-3 py-3">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <dt className="font-semibold text-foreground">What happened</dt>
                        <dd>{submitFailure.detail}</dd>
                        <dt className="font-semibold text-foreground">Can retry</dt>
                        <dd>{submitFailure.retryable ? "Yes — the same data can be re-sent." : "No — something needs changing first."}</dd>
                        {submitFailure.status !== undefined && !Number.isNaN(submitFailure.status) && (
                          <>
                            <dt className="font-semibold text-foreground">Status</dt>
                            <dd>HTTP {submitFailure.status}</dd>
                          </>
                        )}
                        <dt className="font-semibold text-foreground">Attempts</dt>
                        <dd>{attempts}</dd>
                      </dl>
                      <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-border bg-background/80 p-3 font-mono text-[11px] leading-relaxed text-foreground">
{submitFailure.raw ?? "No technical detail captured."}
                      </pre>
                      <button
                        type="button"
                        onClick={copyRawError}
                        className="mt-3 inline-flex min-h-11 items-center justify-center border border-border-strong px-4 py-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary hover:text-white"
                      >
                        Copy error message
                      </button>
                    </div>
                  </details>

                  {/* Easy hand-off to a human, with the error context attached. */}
                  <div className="mt-4 border-t border-[#e11d2e]/40 pt-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Still stuck? Contact support
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <a
                        href={supportMailto()}
                        className="inline-flex min-h-11 items-center justify-center border border-[#4b8bff] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-[#8fb6ff] transition-colors hover:bg-[#4b8bff]/10 hover:text-white"
                      >
                        Email support with these details
                      </a>
                      <button
                        type="button"
                        onClick={copyDiagnostics}
                        className="inline-flex min-h-11 items-center justify-center border border-border-strong px-4 py-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary hover:text-white"
                      >
                        Copy error details
                      </button>
                    </div>
                    <p role="status" aria-live="polite" className="mt-2 text-[11px] text-muted-foreground">
                      {copyMessage || `We reply from ${SUPPORT_EMAIL}, usually within one business day.`}
                    </p>
                  </div>
                </div>
              )}


              {/* Submit-time upload progress with an escape hatch. */}
              {sendPhase !== "idle" && (
                <div
                  ref={progressRef}
                  tabIndex={-1}
                  role="group"
                  aria-labelledby={fid("send-heading")}
                  className={`border p-4 outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e] ${
                    sendPhase === "error"
                      ? "border-[#e11d2e]/60 bg-[#e11d2e]/10"
                      : sendPhase === "cancelled"
                        ? "border-[#ffca6b]/60 bg-[#ffca6b]/10"
                        : sendPhase === "done"
                          ? "border-[#4b8bff]/60 bg-[#4b8bff]/10"
                          : "border-border bg-surface/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      id={fid("send-heading")}
                      className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground"
                    >

                      {sendPhase === "sending"
                        ? "Uploading application…"
                        : sendPhase === "done"
                          ? "Upload complete"
                          : sendPhase === "cancelled"
                            ? "Upload cancelled"
                            : "Upload failed"}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {sendProgress}%
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={sendProgress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Application upload progress"
                    aria-valuetext={
                      sendPhase === "done"
                        ? "Upload complete"
                        : sendPhase === "cancelled"
                          ? `Cancelled at ${sendProgress} percent`
                          : sendPhase === "error"
                            ? `Failed at ${sendProgress} percent`
                            : `${sendProgress} percent uploaded`
                    }
                    className="mt-3 h-2 w-full overflow-hidden bg-border"
                  >
                    <div
                      className={`h-full transition-[width] duration-300 motion-reduce:transition-none ${
                        sendPhase === "done"
                          ? "bg-[#4b8bff]"
                          : sendPhase === "cancelled"
                            ? "bg-[#ffca6b]"
                            : sendPhase === "error"
                              ? "bg-[#e11d2e]"
                              : "bg-[#e11d2e]"
                      }`}
                      style={{ width: `${sendProgress}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {sendPhase === "sending"
                      ? file
                        ? `Sending your application and ${file.name}. Keep this window open.`
                        : "Sending your application. Keep this window open."
                      : sendPhase === "done"
                        ? "Your application reached the Hybrid team."
                        : sendPhase === "cancelled"
                          ? "Nothing was sent. Your answers and attachment are still filled in."
                          : "Nothing was sent. See the details above and try again."}
                  </p>

                  {resumedAt !== null && (
                    <p className="mt-2 border border-[#ffca6b]/50 bg-[#ffca6b]/10 px-3 py-2 text-xs text-[#ffca6b]">
                      Progress restored from {formatTime(resumedAt)} — this run stopped at{" "}
                      {sendProgress}%
                      {resumedFileName ? ` while sending ${resumedFileName}` : ""}.
                      {resumedFileName && !file
                        ? " Re-attach your file before retrying."
                        : " Use Retry submission to finish it."}
                    </p>
                  )}



                  {activity.length > 0 && (
                    <details
                      open={sendPhase !== "done"}
                      className="mt-3 border border-border-strong bg-background/60"
                    >
                      <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
                        Live activity log ({activity.length})
                      </summary>
                      <ol
                        aria-live="polite"
                        aria-label="Live submission activity"
                        className="max-h-44 space-y-1.5 overflow-y-auto border-t border-border px-3 py-2"
                      >
                        {activity.map((e, i) => (
                          <li
                            key={`${e.at}-${i}`}
                            className="flex gap-2 text-[11px] leading-relaxed text-muted-foreground"
                          >
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                              {formatTime(e.at)}
                            </span>
                            <span
                              aria-hidden="true"
                              className={`mt-1 inline-block size-1.5 shrink-0 ${
                                e.kind === "ok"
                                  ? "bg-[#4b8bff]"
                                  : e.kind === "warn"
                                    ? "bg-[#ffca6b]"
                                    : e.kind === "error"
                                      ? "bg-[#e11d2e]"
                                      : "bg-border-strong"
                              }`}
                            />
                            <span>
                              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground">
                                {e.stage}
                              </span>{" "}
                              — {e.message}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}

                  {/* Milestone list: a visible, screen-reader friendly account of
                      where the submission is, with a live estimate per stage. */}
                  <ol className="mt-3 space-y-1.5" aria-label="Submission stages">
                    {[
                      { label: "Preparing your application", at: 25 },
                      {
                        label: file
                          ? "Uploading your attachment"
                          : "Uploading your answers",
                        at: 60,
                      },
                      { label: "Delivering to the Hybrid team", at: 90 },
                      { label: "Confirming and emailing your receipt", at: 100 },
                    ].map((step) => {
                      const complete = sendPhase === "done" || sendProgress >= step.at;
                      const active =
                        !complete && sendPhase === "sending";
                      const stopped =
                        !complete &&
                        (sendPhase === "error" || sendPhase === "cancelled");
                      const state = complete
                        ? "Complete"
                        : active
                          ? "In progress"
                          : stopped
                            ? "Not completed"
                            : "Pending";
                      // The upload paces ~3% every 400ms, so the remaining
                      // percentage converts directly into a seconds estimate.
                      const secondsLeft = Math.max(
                        1,
                        Math.ceil(((step.at - sendProgress) / 3) * 0.4),
                      );
                      const eta = complete
                        ? "Done"
                        : active
                          ? `~${secondsLeft}s left`
                          : stopped
                            ? "—"
                            : `~${secondsLeft}s`;
                      const etaLabel = complete
                        ? "finished"
                        : active
                          ? `about ${secondsLeft} seconds remaining`
                          : stopped
                            ? "no estimate, submission stopped"
                            : `estimated ${secondsLeft} seconds`;
                      return (
                        <li
                          key={step.label}
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <span
                            aria-hidden="true"
                            className={`inline-block size-2 shrink-0 ${
                              complete
                                ? "bg-[#4b8bff]"
                                : active
                                  ? "bg-[#e11d2e]"
                                  : stopped
                                    ? "bg-[#ffca6b]"
                                    : "bg-border"
                            }`}
                          />
                          <span className={complete ? "text-foreground" : undefined}>
                            {step.label}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em]">
                            {state}
                          </span>
                          <span
                            className={`ms-auto shrink-0 font-mono text-[10px] tabular-nums tracking-[0.12em] ${
                              active ? "text-[#e11d2e]" : "text-muted-foreground"
                            }`}
                          >
                            <span aria-hidden="true">{eta}</span>
                            <span className="sr-only">{etaLabel}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>


                  {sendPhase === "done" && (
                    <div className="mt-3 border-t border-[#4b8bff]/40 pt-3">
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#bcd4ff]">
                        What happens next
                      </p>
                      <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs text-muted-foreground">
                        <li>We email your confirmation receipt and reference code.</li>
                        <li>A producer reviews your track within 24–48 hours.</li>
                        <li>You receive a production plan and invoice — no charge today.</li>
                      </ol>
                    </div>
                  )}

                  {(sendPhase === "error" || sendPhase === "cancelled") && (
                    <div className="mt-3 border-t border-border pt-3">
                      {reference && (
                        <div className="mb-3 flex flex-col gap-2 border border-border-strong bg-background/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                              Your reference code
                            </p>
                            <p className="mt-1 select-all font-mono text-sm font-semibold tracking-[0.12em] text-foreground">
                              {reference}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={copyReference}
                            aria-label={`Copy reference code ${reference} to clipboard`}
                            className="inline-flex min-h-11 shrink-0 items-center justify-center border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
                          >
                            Copy code
                          </button>
                        </div>
                      )}
                      {reference && (
                        <p role="status" aria-live="polite" className="mb-3 text-[11px] text-muted-foreground">
                          {copyRefMessage}
                        </p>
                      )}
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
                        What to do next
                      </p>
                      <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs text-muted-foreground">
                        <li>Your answers and attachment are still here — nothing was lost.</li>
                        <li>
                          {sendPhase === "cancelled"
                            ? "Press Review Application when you are ready to send again."
                            : "Use Retry upload to send the same application again."}
                        </li>
                        <li>
                          Still stuck? Email Hybrid.AI.Records@proton.me and we will take it from
                          there.
                        </li>
                      </ol>
                      {/* One-click retry: resends the same application and
                          resets the milestone list back to stage one. */}
                      <button
                        type="button"
                        onClick={retryUpload}
                        disabled={submitting}
                        aria-label={
                          file
                            ? `Retry submission and re-upload ${file.name}`
                            : "Retry sending this application"
                        }
                        className="mt-3 inline-flex min-h-11 items-center bg-[#e11d2e] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white transition-shadow hover:shadow-[0_0_18px_rgba(225,29,46,0.55)] disabled:opacity-60"
                      >
                        {submitting ? "Retrying…" : "Retry submission"}
                      </button>
                    </div>
                  )}


                  {sendPhase === "sending" && !confirmCancel && (
                    <button
                      type="button"
                      onClick={requestCancel}
                      aria-label={
                        file
                          ? `Cancel upload of ${file.name} and stop sending this application`
                          : "Cancel upload and stop sending this application"
                      }
                      className="mt-3 inline-flex min-h-11 items-center border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      Cancel upload
                    </button>
                  )}

                  {sendPhase === "sending" && confirmCancel && (
                    <div
                      role="alertdialog"
                      aria-label="Confirm cancelling your upload"
                      className="mt-3 border border-[#ffca6b]/60 bg-[#ffca6b]/10 p-3"
                    >
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#ffca6b]">
                        Stop this upload?
                      </p>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Your submission is {sendProgress}% sent
                        {file ? ` with ${file.name} attached` : ""}. Cancelling stops it before it
                        reaches the Hybrid team — your answers stay filled in and you can send again.
                      </p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          onClick={dismissCancel}
                          autoFocus
                          className="inline-flex min-h-11 items-center justify-center bg-[#e11d2e] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white transition-shadow hover:shadow-[0_0_18px_rgba(225,29,46,0.55)]"
                        >
                          Keep uploading
                        </button>
                        <button
                          type="button"
                          onClick={cancelSubmit}
                          className="inline-flex min-h-11 items-center justify-center border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-[#ffca6b] hover:text-[#ffca6b]"
                        >
                          Yes, stop upload
                        </button>
                      </div>
                    </div>
                  )}

                </div>
              )}

              {reviewing && !submitting && (
                <div
                  ref={reviewRef}
                  tabIndex={-1}
                  role="group"
                  aria-labelledby={fid("review-heading")}
                  className="border border-[#e11d2e]/60 bg-background/60 p-4 outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e]"
                >
                  <h3
                    id={fid("review-heading")}
                    className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e11d2e]"
                  >
                    Step 2 of 2 — Final review
                  </h3>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Nothing has been sent yet. Check the details below, then confirm to submit.
                  </p>
                  {needsReconfirm && (
                    <p className="mt-2 border border-[#e11d2e]/50 bg-[#e11d2e]/10 px-3 py-2 text-xs text-[#ffb3bb]">
                      Your answers changed. This recap is up to date — confirm again to submit.
                    </p>
                  )}

                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    {[
                      { k: "Artist / project", v: artist.trim(), f: "artist" as FieldName },
                      { k: "Contact email", v: email.trim(), f: "email" as FieldName },
                      {
                        k: "Package",
                        v:
                          PACKAGE_OPTIONS.find((o) => o.value === pkg)?.label ??
                          pkg,
                        f: "pkg" as FieldName,
                      },
                      {
                        k: "Reference link",
                        v: link.trim() || "None provided",
                        f: "link" as FieldName,
                      },
                      {
                        k: "Attachment",
                        v: file
                          ? `${file.name}${fileMeta ? ` — ${fileMeta.formatLabel}, ${fileMeta.sizeLabel}${
                              fileMeta.durationSeconds
                                ? `, ${formatDuration(fileMeta.durationSeconds)}`
                                : ""
                            }` : ""}`
                          : "No file attached",
                        f: "file" as FieldName,
                      },
                      {
                        k: "Policy acknowledgment",
                        v: ack ? "Accepted" : "Not accepted",
                        f: "ack" as FieldName,
                      },
                      { k: "Notes", v: notes.trim() || "None provided", f: "notes" as FieldName },
                    ].map((row) => (
                      <div key={row.k}>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          {row.k}
                        </dt>
                        <dd className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 break-words text-sm text-foreground">
                          <span className="min-w-0 break-words">{row.v}</span>
                          <button
                            type="button"
                            onClick={() => editFromReview(row.f, row.k)}
                            aria-label={`Edit ${row.k}. Your final review stays open.`}
                            className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fb6ff] underline underline-offset-4 transition-colors hover:text-white"
                          >
                            Edit
                          </button>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Choosing Edit keeps this review open — change the field, then come back here and
                    press Confirm and submit.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => editFromReview("artist", "Project details")}
                      className="min-h-11 border border-border-strong px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      Edit details section
                    </button>
                    <button
                      type="button"
                      onClick={() => editFromReview("file", "Attachments")}
                      className="min-h-11 border border-border-strong px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      Edit attachments section
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReviewing(false);
                        setNeedsReconfirm(false);
                        setStatusMessage(
                          "Review cancelled. You are back in the form and can edit your answers.",
                        );
                      }}
                      className="min-h-11 border border-border-strong px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-white hover:text-white"
                    >
                      Go back and edit everything
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="border border-border px-6 py-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-white hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  aria-busy={submitting}
                  className="bg-[#e11d2e] px-6 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting
                    ? "Sending…"
                    : reviewing
                      ? needsReconfirm
                        ? "Confirm changes and submit"
                        : "Confirm and submit"
                      : submitFailure?.retryable
                        ? "Try again"
                        : "Review Application"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const inputClass = (invalid?: boolean) =>
  `w-full border bg-background/40 px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary ${
    invalid ? "border-[#e11d2e]" : "border-border"
  }`;

function Field({
  id,
  label,
  hint,
  hintId,
  required,
  error,
  errorId,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  hintId?: string;
  required?: boolean;
  error?: string;
  errorId?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-white"
        >
          {label}
          {required && (
            <span className="ms-1 text-[#e11d2e]" aria-hidden="true">
              *
            </span>
          )}
        </label>
        {hint && (
          <span id={hintId} className="text-[10px] text-muted-foreground">
            {hint}
          </span>
        )}
      </div>
      {children}
      {error && errorId && (
        <p id={errorId} className="mt-1.5 flex items-center gap-1.5 text-xs text-[#ff6b78]">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
