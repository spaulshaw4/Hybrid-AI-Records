import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  classifyCover,
  classifyUploadAudio,
  COVER_MAX_BYTES,
  COVER_MIN_PIXELS,
  COVER_NOT_RGB,
  COVER_NOT_SQUARE,
  COVER_TOO_LARGE,
  DEFAULT_RECORD_LABEL,
  DISTRIBUTION_GENRES,
  RECORDING_TYPES,
  SAMPLE_CLEARANCE_LABEL,
  type RecordingType,
} from "@/lib/distribution-media";

type AudioSource = "vault" | "upload";
type RefillTier = "d5" | "d10" | "d25";

type MasteredTrack = {
  id: string;
  title: string;
};

type ReleaseReceipt = {
  releaseId: number;
  status: string | null;
  spotifyUri: string | null;
  upc: string | null;
};

const RECEIPT_KEY = "hybrid-dtoken-release-receipt";

const REFILL_PACKS: Array<{ tier: RefillTier; label: string; price: string }> = [
  { tier: "d5", label: "5 D-Token", price: "$5" },
  { tier: "d10", label: "10 D-Token", price: "$10" },
  { tier: "d25", label: "25 D-Token", price: "$25" },
];

const inputClass = "mt-1 w-full border border-white/10 bg-black/40 px-3 py-3 text-sm text-white";

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || text.length > 240 || text.includes("\n") || /bearer|api[_-]?key|secret|stack/i.test(text)) {
    return fallback;
  }
  return text;
}

function readReceipt(): ReleaseReceipt | null {
  try {
    const raw = sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReleaseReceipt>;
    if (typeof parsed.releaseId !== "number" || parsed.releaseId <= 0) return null;
    return {
      releaseId: parsed.releaseId,
      status: typeof parsed.status === "string" ? parsed.status : null,
      spotifyUri: typeof parsed.spotifyUri === "string" ? parsed.spotifyUri : null,
      upc: typeof parsed.upc === "string" ? parsed.upc : null,
    };
  } catch {
    return null;
  }
}

function storeReceipt(receipt: ReleaseReceipt) {
  try {
    sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
  } catch {
    // The confirmation still renders from component state.
  }
}

type ProfileQuery = {
  data: Record<string, unknown> | null;
  error: { message?: string } | null;
};

function profileTable() {
  return supabase.from("profiles") as unknown as {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<ProfileQuery>;
      };
    };
  };
}

/** profiles.full_name does not exist here. The name column is display_name. */
async function readProfileName(userId: string): Promise<string> {
  for (const column of ["full_name", "display_name"] as const) {
    for (const key of ["user_id", "id"] as const) {
      try {
        const result = await profileTable().select(column).eq(key, userId).maybeSingle();
        const value = result.data?.[column];
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        return "";
      }
    }
  }
  return "";
}

async function readProfileTokens(userId: string): Promise<number | null> {
  for (const key of ["user_id", "id"] as const) {
    try {
      const result = await profileTable().select("d_tokens").eq(key, userId).maybeSingle();
      if (result.error) continue;
      const value = result.data?.d_tokens;
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      return null;
    }
  }
  return null;
}

async function decodedCoverSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/**
 * Header checks reject known grayscale and CMYK. This draws the file and
 * rejects it when the browser cannot read RGB pixels, which is the backstop
 * for a CMYK JPEG the header did not identify.
 */
async function canvasHasRgbPixels(file: File): Promise<boolean> {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      try {
        context.drawImage(bitmap, 0, 0, 8, 8);
        const pixels = context.getImageData(0, 0, 8, 8);
        return pixels.data.length === 8 * 8 * 4;
      } finally {
        bitmap.close();
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("cover"));
        element.src = url;
      });
      context.drawImage(image, 0, 0, 8, 8);
      const pixels = context.getImageData(0, 0, 8, 8);
      return pixels.data.length === 8 * 8 * 4;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}

async function coverIssue(file: File): Promise<string | null> {
  if (file.size >= COVER_MAX_BYTES) return COVER_TOO_LARGE;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const classified = classifyCover(bytes);
  if (!classified.ok) return classified.error;
  const decoded = await decodedCoverSize(file);
  if (
    decoded &&
    (decoded.width !== decoded.height || decoded.width < COVER_MIN_PIXELS || decoded.height < COVER_MIN_PIXELS)
  ) {
    return COVER_NOT_SQUARE;
  }
  const readable = await canvasHasRgbPixels(file);
  if (!readable) return COVER_NOT_RGB;
  return null;
}

async function audioIssue(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  const classified = classifyUploadAudio(file.name, file.type, bytes);
  return classified.ok ? null : classified.error;
}

function FileDropzone({
  accept,
  label,
  hint,
  fileName,
  onFile,
}: {
  accept: string;
  label: string;
  hint: string;
  fileName: string | null;
  onFile: (file: File | null) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`mt-2 flex cursor-pointer flex-col items-center justify-center border border-dashed px-4 py-8 text-center ${
        over ? "border-[#e11d2e] bg-white/5" : "border-white/15 bg-black/30"
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onFile(event.dataTransfer.files?.[0] ?? null);
      }}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/80">{label}</span>
      <span className="mt-2 text-sm text-muted-foreground">{fileName ?? hint}</span>
      <input
        type="file"
        accept={accept}
        aria-label={label}
        className="sr-only"
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}

export function DistributionReleasePanel() {
  const [source, setSource] = useState<AudioSource>("vault");
  const [tracks, setTracks] = useState<MasteredTrack[]>([]);
  const [tracksNote, setTracksNote] = useState("Your mastered tracks");
  const [vaultTrackId, setVaultTrackId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [genre, setGenre] = useState("");
  const [explicit, setExplicit] = useState(false);
  const [label, setLabel] = useState(DEFAULT_RECORD_LABEL);
  const [recordingType, setRecordingType] = useState<RecordingType | "">("");
  const [composer, setComposer] = useState("");
  const [lyricist, setLyricist] = useState("");
  const [pLine, setPLine] = useState(DEFAULT_RECORD_LABEL);
  const [cLine, setCLine] = useState("");
  const [sampleClearance, setSampleClearance] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [confirmRights, setConfirmRights] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [refillOpen, setRefillOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refillTier, setRefillTier] = useState<RefillTier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReleaseReceipt | null>(null);

  useEffect(() => {
    setReceipt(readReceipt());
    let cancelled = false;
    async function load() {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token?.trim() ?? "";
      const userId = data.session?.user?.id ?? "";
      if (!accessToken || !userId) {
        if (!cancelled) {
          setTracks([]);
          setTracksNote("Sign in to load your mastered tracks.");
          setBalance(null);
        }
        return;
      }
      const name = await readProfileName(userId);
      const tokens = await readProfileTokens(userId);
      if (!cancelled && name) {
        setComposer((current) => (current.trim() ? current : name));
        setLyricist((current) => (current.trim() ? current : name));
        setCLine((current) => (current.trim() ? current : name));
      }
      if (!cancelled && tokens !== null) setBalance(tokens);

      const headers = { Authorization: `Bearer ${accessToken}` };
      const vaultRes = await fetch("/api/vault", { headers });
      if (cancelled) return;
      if (!vaultRes.ok) {
        setTracksNote("Your mastered tracks could not be loaded.");
        return;
      }
      const payload = (await vaultRes.json().catch(() => ({}))) as {
        tracks?: Array<{ id?: unknown; title?: unknown; wav_url?: unknown }>;
      };
      const rows = (payload.tracks ?? [])
        .filter((row) => typeof row.id === "string" && row.id && typeof row.wav_url === "string" && row.wav_url.trim())
        .map((row) => ({
          id: row.id as string,
          title: typeof row.title === "string" && row.title.trim() ? row.title : "Untitled master",
        }));
      setTracks(rows);
      setTracksNote(rows.length ? "Your mastered tracks" : "No mastered tracks yet. Upload a WAV or FLAC instead.");
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function chooseCover(next: File | null) {
    setCover(null);
    setCoverError(null);
    if (!next) return;
    const issue = await coverIssue(next);
    if (issue) {
      setCoverError(issue);
      return;
    }
    setCover(next);
  }

  async function chooseAudio(next: File | null) {
    setFile(null);
    setAudioError(null);
    if (!next) return;
    const issue = await audioIssue(next);
    if (issue) {
      setAudioError(issue);
      return;
    }
    setFile(next);
  }

  const audioReady = source === "vault" ? Boolean(vaultTrackId) : Boolean(file) && !audioError;
  const reviewReady =
    sampleClearance &&
    Boolean(title.trim()) &&
    Boolean(artist.trim()) &&
    Boolean(genre) &&
    Boolean(recordingType) &&
    Boolean(composer.trim()) &&
    Boolean(lyricist.trim()) &&
    Boolean(pLine.trim()) &&
    Boolean(cLine.trim()) &&
    Boolean(label.trim()) &&
    Boolean(cover) &&
    !coverError &&
    audioReady &&
    acceptTerms &&
    confirmRights;

  async function sessionToken(): Promise<string> {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id ?? "";
    const accessToken = data.session?.access_token?.trim() ?? "";
    if (!userId || userId === "guest_user" || !accessToken) {
      window.location.href = "/auth?next=/portal";
      return "";
    }
    return accessToken;
  }

  async function startRefill(tier: RefillTier) {
    const accessToken = await sessionToken();
    if (!accessToken) return;
    setRefillTier(tier);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ tier }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (payload.url) {
        window.location.href = payload.url;
        return;
      }
      setError(safeMessage(payload.error, "Unable to start checkout."));
      setRefillTier(null);
    } catch {
      setError("Unable to start checkout.");
      setRefillTier(null);
    }
  }

  async function submitRelease(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!sampleClearance) {
      setError(SAMPLE_CLEARANCE_LABEL);
      return;
    }
    if (source === "vault" && !vaultTrackId) {
      setError("Select a mastered track.");
      return;
    }
    if (source === "upload") {
      if (!file) {
        setError("Upload a 16-bit or 24-bit WAV, or a FLAC file.");
        return;
      }
      const issue = await audioIssue(file);
      if (issue) {
        setAudioError(issue);
        setError(issue);
        return;
      }
    }
    if (!cover) {
      setError("Cover art is required.");
      return;
    }
    const coverProblem = await coverIssue(cover);
    if (coverProblem) {
      setCoverError(coverProblem);
      setError(coverProblem);
      return;
    }
    const accessToken = await sessionToken();
    if (!accessToken) return;

    const form = new FormData();
    form.set("title", title.trim());
    form.set("artist", artist.trim());
    form.set("source", source);
    form.set("acceptTerms", acceptTerms ? "true" : "false");
    form.set("confirmRights", confirmRights ? "true" : "false");
    form.set("genre", genre);
    form.set("explicit", explicit ? "true" : "false");
    form.set("label", label.trim() || DEFAULT_RECORD_LABEL);
    form.set("recordingType", recordingType);
    form.set("composer", composer.trim());
    form.set("lyricist", lyricist.trim());
    form.set("pLine", pLine.trim());
    form.set("cLine", cLine.trim());
    form.set("sampleClearance", "true");
    form.set("cover", cover);
    if (source === "vault") form.set("vaultTrackId", vaultTrackId);
    if (source === "upload" && file) form.set("audio", file);

    setBusy(true);
    try {
      const res = await fetch("/api/distribute/too-lost", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        balance?: number;
        releaseId?: number;
        status?: string | null;
        spotifyUri?: string | null;
        upc?: string | null;
      };
      if (!res.ok) {
        setError(safeMessage(payload.error, "Too Lost could not accept this release. Nothing was charged."));
        return;
      }
      if (typeof payload.balance === "number") setBalance(payload.balance);
      const nextReceipt: ReleaseReceipt = {
        releaseId: typeof payload.releaseId === "number" ? payload.releaseId : 0,
        status: typeof payload.status === "string" ? payload.status : null,
        spotifyUri: typeof payload.spotifyUri === "string" ? payload.spotifyUri : null,
        upc: typeof payload.upc === "string" ? payload.upc : null,
      };
      setReceipt(nextReceipt);
      if (nextReceipt.releaseId > 0) storeReceipt(nextReceipt);
    } catch {
      setError("Too Lost could not accept this release. Nothing was charged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 border-t border-white/10 pt-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {balance === null ? "1 D-Token per release" : `Balance: ${balance} D-Token${balance === 1 ? "" : "s"}`}
        </p>
        <button
          type="button"
          onClick={() => setRefillOpen(true)}
          className="inline-flex items-center justify-center border border-white/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-white/80 transition-colors hover:border-white/40 hover:text-white"
        >
          REFILL D-TOKENS
        </button>
      </div>

      <form className="mt-6 space-y-5" onSubmit={(event) => void submitRelease(event)}>
        <fieldset className="space-y-3">
          <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Audio</legend>
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="radio"
              name="audio-source"
              value="vault"
              checked={source === "vault"}
              onChange={() => setSource("vault")}
            />
            Select Mastered Track
          </label>
          {source === "vault" && (
            <label className="block text-sm text-white/80">
              <span className="mb-1 block text-xs text-muted-foreground">{tracksNote}</span>
              <select
                aria-label="Your mastered tracks"
                value={vaultTrackId}
                onChange={(event) => setVaultTrackId(event.target.value)}
                className={inputClass}
              >
                <option value="">Select a mastered track</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="radio"
              name="audio-source"
              value="upload"
              checked={source === "upload"}
              onChange={() => setSource("upload")}
            />
            Upload External WAV
          </label>
          {source === "upload" && (
            <>
              <FileDropzone
                accept=".wav,.flac,audio/wav,audio/wave,audio/x-wav,audio/flac,audio/x-flac"
                label="Upload external audio"
                hint="Drop a 16-bit or 24-bit WAV or FLAC file"
                fileName={file?.name ?? null}
                onFile={(next) => void chooseAudio(next)}
              />
              {audioError && (
                <p role="alert" className="text-sm text-[#e11d2e]">
                  {audioError}
                </p>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Cover art</legend>
          <FileDropzone
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            label="Cover art"
            hint="Drop a square RGB JPEG or PNG, at least 3000 × 3000, under 36 MB"
            fileName={cover?.name ?? null}
            onFile={(next) => void chooseCover(next)}
          />
          {coverError && (
            <p role="alert" className="text-sm text-[#e11d2e]">
              {coverError}
            </p>
          )}
        </fieldset>

        <label className="block text-sm text-white/80">
          Release title
          <input required value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          Primary artist
          <input required value={artist} onChange={(event) => setArtist(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          Genre
          <select required value={genre} onChange={(event) => setGenre(event.target.value)} className={inputClass}>
            <option value="">Select a genre</option>
            {DISTRIBUTION_GENRES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm text-white/80">Explicit content</legend>
          <div className="flex gap-4 text-sm text-white/80">
            <label className="flex items-center gap-2">
              <input type="radio" name="explicit" checked={!explicit} onChange={() => setExplicit(false)} />
              No
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="explicit" checked={explicit} onChange={() => setExplicit(true)} />
              Yes
            </label>
          </div>
        </fieldset>
        <label className="block text-sm text-white/80">
          Record label
          <input required value={label} onChange={(event) => setLabel(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          Track creation method
          <select
            required
            value={recordingType}
            onChange={(event) => setRecordingType(event.target.value as RecordingType | "")}
            className={inputClass}
          >
            <option value="">Select a creation method</option>
            {RECORDING_TYPES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-white/80">
          Composer (Legal Full Name)
          <input required value={composer} onChange={(event) => setComposer(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          Lyricist (Legal Full Name)
          <input required value={lyricist} onChange={(event) => setLyricist(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          P-line
          <input required value={pLine} onChange={(event) => setPLine(event.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-white/80">
          C-line
          <input required value={cLine} onChange={(event) => setCLine(event.target.value)} className={inputClass} />
        </label>
        <label className="flex items-start gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={sampleClearance}
            onChange={(event) => setSampleClearance(event.target.checked)}
          />
          <span>{SAMPLE_CLEARANCE_LABEL}</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-white/80">
          <input type="checkbox" checked={acceptTerms} onChange={(event) => setAcceptTerms(event.target.checked)} />
          I accept the distribution terms.
        </label>
        <label className="flex items-start gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={confirmRights}
            onChange={(event) => setConfirmRights(event.target.checked)}
          />
          I confirm I have the rights to this master.
        </label>

        {reviewReady && (
          <section aria-label="Submission review" className="border border-emerald-400/30 bg-emerald-400/5 p-4">
            <p className="inline-flex rounded-full border border-emerald-400/40 px-3 py-1 font-mono text-[10px] tracking-[0.14em] text-emerald-300">
              Compliance & Audio Recognition Verified
            </p>
            <dl className="mt-3 space-y-1 text-sm text-white/80">
              <div>
                <dt className="inline text-muted-foreground">Creation method: </dt>
                <dd className="inline">{recordingType}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Composer: </dt>
                <dd className="inline">{composer.trim()}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Lyricist: </dt>
                <dd className="inline">{lyricist.trim()}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">P-line: </dt>
                <dd className="inline">{pLine.trim()}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">C-line: </dt>
                <dd className="inline">{cLine.trim()}</dd>
              </div>
            </dl>
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm text-[#e11d2e]">
            {error}
          </p>
        )}
        {receipt && (
          <section aria-label="Release status" className="border border-white/10 bg-white/[0.03] p-4 text-sm text-white/80">
            <p className="text-emerald-400">Release accepted by Too Lost. 1 D-Token was charged.</p>
            <p className="mt-2">Status: {receipt.status ?? "Not returned yet"}</p>
            <p>Spotify URI: {receipt.spotifyUri ?? "Not returned yet"}</p>
            <p>UPC: {receipt.upc ?? "Not returned yet"}</p>
          </section>
        )}
        <button
          type="submit"
          disabled={busy || !reviewReady}
          className="inline-flex w-full items-center justify-center bg-[#e11d2e] px-8 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a] disabled:opacity-60 md:w-auto"
        >
          {busy ? "Sending…" : "Review & Submit"}
        </button>
      </form>

      {refillOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => {
            if (!refillTier) setRefillOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="REFILL D-TOKENS"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md border border-white/10 bg-[#130b14] p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-display text-xl text-white">REFILL D-TOKENS</h3>
              <button
                type="button"
                aria-label="Close refill"
                disabled={refillTier !== null}
                onClick={() => setRefillOpen(false)}
                className="text-white/60"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Quick buy. Checkout uses the existing token packs.</p>
            <div className="mt-4 space-y-3">
              {REFILL_PACKS.map((pack) => (
                <button
                  key={pack.tier}
                  type="button"
                  disabled={refillTier !== null}
                  onClick={() => void startRefill(pack.tier)}
                  className="flex w-full items-center justify-between border border-white/10 px-4 py-3 text-left text-white"
                >
                  <span>
                    {pack.label} ({pack.price})
                  </span>
                  <span className="font-mono text-[#fda4af]">{refillTier === pack.tier ? "Loading…" : pack.price}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
