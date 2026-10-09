import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { Lock, Sparkles } from "lucide-react";

import CharacterModal, {
  isAudioVaultHttpsUrl,
  type SelectedVocal,
  type VocalCharacter,
} from "@/components/studio/CharacterModal";
import { supabase } from "@/integrations/supabase/client";
import BuyTokensModal from "@/components/studio/BuyTokensModal";
import MyPromptsModal, { type SavedPromptItem } from "@/components/studio/MyPromptsModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { AudioVaultList, type VaultTrackReference } from "@/components/studio/AudioVaultList";
import { DurationSlider } from "@/components/studio/DurationSlider";
import { PatriotGlassStudio } from "@/components/studio/PatriotGlassStudio";
import { StudioFooter } from "@/components/studio/StudioFooter";
import {
  VocalGenderCard,
  VocalStudioTab,
  appendAcousticTags,
  type VisualSongDraft,
  type VocalStudioReference,
} from "@/components/studio/VocalStudioTab";
import { MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";
import { waitForVaultedTrack } from "@/lib/wavespeed-track-client";

const PROMPT_RECORDS_KEY = "hybrid_prompt_records";
const VIBE_PLACEHOLDER =
  "Describe a vibe, tempo, or instruments (e.g., 90 BPM lo-fi hip hop with Rhodes piano & upright bass)...";
const VIBE_SOUND_DESIGN =
  "Act as a sound designer. Expand the rough instrumental vibe into detailed acoustic keywords: BPM, specific instrumentation, analog warmth, and rhythmic groove. No vocals.";

function vibeEnhanceSeed(rough: string): string {
  const vibe = rough.trim();
  if (!vibe) {
    return `${VIBE_SOUND_DESIGN} Invent one concrete instrumental production.`;
  }
  return `${VIBE_SOUND_DESIGN} Rough vibe: ${vibe}`;
}

function vibeEnhanceError(message: string): string {
  if (/wavespeed|replicate|claude|aimusic/i.test(message)) return "Could not enhance that vibe.";
  const text = message.trim();
  return text || "Could not enhance that vibe.";
}

function studioPublicError(message: string, fallback: string): string {
  if (/wavespeed|replicate|gemini|claude|supabase|aimusic/i.test(message)) return fallback;
  const text = message.trim();
  return text || fallback;
}

const compactActionClass =
  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border disabled:cursor-not-allowed disabled:opacity-60";
const badgeActionClass = `${compactActionClass} border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20`;
const renderButtonClass =
  "flex h-12 w-full items-center justify-center rounded-lg border border-red-500 bg-red-600 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800";
const secondaryActionClass = `${compactActionClass} bg-transparent text-zinc-300 hover:bg-white/5 border-white/10`;

type StudioModal = "reference" | "visual" | null;

interface VaultTrack {
  id: string;
  title: string;
  genre: string;
  duration: string;
  status: string;
  wav_url: string;
  mp3_url: string;
}

type AttachedReference =
  | { kind: "file"; name: string; file: File }
  | { kind: "vault"; url: string; title: string };

async function uploadReferenceWav(file: File, accessToken: string): Promise<string> {
  const body = new FormData();
  body.append("audio", file, file.name || "reference.wav");
  const response = await fetch("/api/vocals/reference", {
    method: "POST",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body,
  });
  const raw = await response.text();
  let payload: { url?: unknown; error?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") payload = parsed as { url?: unknown; error?: unknown };
  } catch {
    throw new Error("Could not upload that reference.");
  }
  if (!response.ok || typeof payload.url !== "string") {
    const message = typeof payload.error === "string" ? payload.error : "Could not upload that reference.";
    throw new Error(message);
  }
  return payload.url.trim();
}

function referenceAudioKind(bytes: Uint8Array): "wav" | "mp3" | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return null;
  }
  const ascii = (start: number, end: number) => {
    let text = "";
    for (let index = start; index < end && index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index] ?? 0);
    }
    return text;
  };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

function safeReferenceName(originalName: string, extension: "wav" | "mp3"): string {
  const suffix = `.${extension}`;
  const sanitized = (originalName.trim() || "reference").replace(/[^A-Za-z0-9._-]/g, "_");
  const stem = sanitized.replace(/\.[A-Za-z0-9]+$/i, "").replace(/\.+$/g, "");
  return `${stem || "reference"}${suffix}`;
}

/** Drop a token query. Signed object URLs are not reference audio. */
function publicReferenceAudioUrl(raw: string, userId: string): string {
  if (!raw || !userId) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
  if (parsed.pathname.includes("/object/sign/")) return "";
  parsed.searchParams.delete("token");
  parsed.search = parsed.searchParams.toString();
  const url = parsed.toString();
  if (/[?&]token=/i.test(url)) return "";
  const marker = `/storage/v1/object/public/audio-vault/references/${userId}/`;
  if (!parsed.pathname.includes(marker)) return "";
  return url;
}

const cardStyle: CSSProperties = {
  backgroundColor: "rgba(15, 10, 20, 0.55)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 12,
  padding: 14,
};

const pillStyle: CSSProperties = {
  backgroundColor: "#121826",
  border: "1px solid #1e293b",
  borderRadius: 8,
  padding: "10px 8px",
  color: "#cbd5e1",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  backgroundColor: "transparent",
  border: "none",
  color: "#f8fafc",
  outline: "none",
  resize: "none",
  fontSize: 14,
  lineHeight: 1.5,
};

function modeTabStyle(active: boolean): CSSProperties {
  return {
    backgroundColor: "transparent",
    border: "none",
    color: active ? "#f9a8d4" : "#e9d5ff",
    fontWeight: 700,
    fontSize: 15,
    borderBottom: active ? "2px solid #e11d48" : "2px solid transparent",
    paddingBottom: 6,
    cursor: "pointer",
  };
}

export function formatVocalReferenceClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

function ActiveVocalReference({ vocal, onRemove }: { vocal: SelectedVocal; onRemove: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-emerald-100">
      <span>
        🎙️ Active Vocal Reference: {vocal.name} ({formatVocalReferenceClock(vocal.duration)})
      </span>
      <span aria-hidden="true">|</span>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        className="border-0 bg-transparent p-0 font-semibold text-emerald-50 underline"
      >
        Preview
      </button>
      <span aria-hidden="true">|</span>
      <button
        type="button"
        onClick={() => {
          try {
            audioRef.current?.pause();
          } catch {
            /* jsdom has no media pause */
          }
          onRemove();
        }}
        className="border-0 bg-transparent p-0 font-semibold text-rose-200 underline"
      >
        Remove
      </button>
      <audio ref={audioRef} src={vocal.url} aria-label="Active vocal reference" onEnded={() => setPlaying(false)} />
    </div>
  );
}

function referenceForStudio(
  character: VocalCharacter | null,
  vocal: SelectedVocal | null,
  bed: VaultTrackReference | null = null,
): VocalStudioReference | undefined {
  const id = character?.vocalId.trim() ?? "";
  const personaId = id && !/^https:\/\//i.test(id) ? id : undefined;
  const dockedVocal = vocal?.isReady && isAudioVaultHttpsUrl(vocal.url) ? vocal.url.trim() : undefined;
  const bedUrl = bed && isAudioVaultHttpsUrl(bed.url) ? bed.url.trim() : undefined;
  const vocalAudioUrl = bedUrl || dockedVocal;
  const label = [character?.name, vocal?.name].filter(Boolean).join(" · ") || undefined;
  if (!label && !personaId && !vocalAudioUrl) return undefined;
  return {
    ...(label ? { label } : {}),
    ...(personaId ? { personaId } : {}),
    ...(vocalAudioUrl ? { vocalAudioUrl } : {}),
  };
}

function readPromptRecords(): SavedPromptItem[] {
  try {
    const raw = localStorage.getItem(PROMPT_RECORDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedPromptItem => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<SavedPromptItem>;
      return (
        typeof row.id === "string" &&
        typeof row.title === "string" &&
        typeof row.prompt === "string" &&
        typeof row.timestamp === "number" &&
        typeof row.isBookmarked === "boolean"
      );
    });
  } catch {
    return [];
  }
}

export function EnginePage() {
  const [activeTab, setActiveTab] = useState<"custom" | "easy" | "vocals">("easy");
  const [lyrics, setLyrics] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [userCharacters] = useState<VocalCharacter[]>([
    {
      id: "char-stephen-oct5",
      name: "My Voice - October 5",
      timbreTag: "Powerful",
      isPublished: true,
      vocalId: "vocal_stephen_oct5_master",
    },
  ]);
  const [selectedCharacter, setSelectedCharacter] = useState<VocalCharacter | null>(null);
  const [selectedVocal, setSelectedVocal] = useState<SelectedVocal | null>(null);
  const [isCharacterModalOpen, setIsCharacterModalOpen] = useState(false);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isBuyTokensOpen, setIsBuyTokensOpen] = useState(false);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [openModal, setOpenModal] = useState<StudioModal>(null);
  const [draftReferenceFile, setDraftReferenceFile] = useState<File | null>(null);
  const [attachedReference, setAttachedReference] = useState<AttachedReference | null>(null);
  const [isAnalyzingReference, setIsAnalyzingReference] = useState(false);
  const referenceAnalysisSeq = useRef(0);
  const [draftVisualFile, setDraftVisualFile] = useState<File | null>(null);
  const [visualName, setVisualName] = useState<string | null>(null);
  const [isInjectingVisual, setIsInjectingVisual] = useState(false);
  const visualAnalysisSeq = useRef(0);
  const [visualSongDraft, setVisualSongDraft] = useState<VisualSongDraft | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isVibeEnhancing, setIsVibeEnhancing] = useState(false);
  const [isLyricsLoading, setIsLyricsLoading] = useState(false);
  const [lyricsAssistCooling, setLyricsAssistCooling] = useState(false);
  const lyricsCooldownTimer = useRef<number | null>(null);
  const [trackLength, setTrackLength] = useState(180);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const [isMyPromptsOpen, setIsMyPromptsOpen] = useState(false);
  const [promptRecords, setPromptRecords] = useState<SavedPromptItem[]>([]);
  const [vaultTracks, setVaultTracks] = useState<VaultTrack[]>([]);
  const [vaultRevision, setVaultRevision] = useState(0);

  useEffect(() => {
    setPromptRecords(readPromptRecords());
  }, []);

  useEffect(() => {
    return () => {
      if (lyricsCooldownTimer.current !== null) window.clearTimeout(lyricsCooldownTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setAuthUserId(data.session?.user?.id ?? null);
        setAuthReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthUserId(null);
        setAuthReady(true);
      });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUserId(session?.user?.id ?? null);
      setAuthReady(true);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const syncTokenBalance = useCallback(async () => {
    if (!authReady) return;
    if (!authUserId) {
      setTokenBalance(null);
      setIsLoadingBalance(false);
      return;
    }
    setIsLoadingBalance(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/user/balance?userId=${encodeURIComponent(authUserId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await res.json().catch(() => ({}))) as { balance?: unknown };
      if (res.ok && typeof body.balance === "number") {
        setTokenBalance(body.balance);
      }
    } catch (err) {
      console.error("Failed to sync token ledger:", err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [authReady, authUserId]);

  useEffect(() => {
    void syncTokenBalance();
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "success") return;
    const timer = window.setTimeout(() => {
      void syncTokenBalance();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [syncTokenBalance]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    const locale = document.querySelector("[data-site-nav='desktop-locale']");
    if (!page || !(locale instanceof HTMLElement)) return;
    const previous = {
      position: locale.style.position,
      zIndex: locale.style.zIndex,
      background: locale.style.background,
    };
    const apply = () => {
      const desktop = window.matchMedia("(min-width: 1024px)").matches;
      const height = desktop ? locale.getBoundingClientRect().height : 0;
      page.style.marginTop = height > 0 ? `-${height}px` : "";
      page.style.paddingTop = height > 0 ? `${24 + height}px` : "24px";
      locale.style.position = height > 0 ? "relative" : previous.position;
      locale.style.zIndex = height > 0 ? "2" : previous.zIndex;
      locale.style.background = height > 0 ? "transparent" : previous.background;
    };
    apply();
    const media = window.matchMedia("(min-width: 1024px)");
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      page.style.marginTop = "";
      page.style.paddingTop = "";
      locale.style.position = previous.position;
      locale.style.zIndex = previous.zIndex;
      locale.style.background = previous.background;
    };
  }, []);

  const handleEnhanceStyle = async () => {
    if (isAiLoading) return;
    const styleText = prompt.trim();
    const lyricsText = lyrics.trim();
    setIsAiLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enhance_style", prompt: styleText, lyrics: lyricsText }),
      });
      const rawText = await res.text();
      let data: { success?: boolean; style?: string; prompt?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { success?: boolean; style?: string; prompt?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const enhanced = (data.style || data.prompt || "").trim();
      if (!res.ok || !enhanced) {
        throw new Error(
          data.error || data.message || (res.ok ? "Style enhancement returned an empty prompt." : "AI request failed"),
        );
      }
      setPrompt(enhanced);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "AI request failed");
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleEnhanceVibe = async () => {
    if (isVibeEnhancing) return;
    const draft = prompt;
    setIsVibeEnhancing(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enhance_style",
          prompt: vibeEnhanceSeed(draft),
          lyrics: "",
        }),
      });
      const rawText = await res.text();
      let data: { success?: boolean; style?: string; prompt?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { success?: boolean; style?: string; prompt?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const enhanced = (data.style || data.prompt || "").trim();
      if (!res.ok || !enhanced) {
        throw new Error(
          data.error || data.message || (res.ok ? "Style enhancement returned an empty prompt." : "Could not enhance that vibe."),
        );
      }
      setPrompt(enhanced);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(vibeEnhanceError(message || "Could not enhance that vibe."));
    } finally {
      setIsVibeEnhancing(false);
    }
  };

  const handleLyricsAssist = async () => {
    if (isLyricsLoading || lyricsAssistCooling) return;
    const styleText = prompt;
    const draft = lyrics;
    const hasDraft = draft.trim().length > 0;
    setIsLyricsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasDraft
            ? { action: "format_lyrics", lyrics: draft, genre: styleText }
            : { action: "generate_lyrics", topic: styleText.trim() || "Overcoming the storm", genre: styleText },
        ),
      });
      const rawText = await res.text();
      let data: { lyrics?: string; result?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { lyrics?: string; result?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const nextLyrics = data.lyrics || data.result || "";
      if (!res.ok || !nextLyrics.trim()) {
        throw new Error(data.error || data.message || "AI request failed");
      }
      setLyrics(nextLyrics);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "AI request failed");
      if (draft.trim()) setLyrics(draft);
    } finally {
      setIsLyricsLoading(false);
      setLyricsAssistCooling(true);
      if (lyricsCooldownTimer.current !== null) window.clearTimeout(lyricsCooldownTimer.current);
      lyricsCooldownTimer.current = window.setTimeout(() => {
        lyricsCooldownTimer.current = null;
        setLyricsAssistCooling(false);
      }, 2000);
    }
  };

  const handleApplyTemplate = (tmpl: TrackTemplate) => {
    setPrompt(tmpl.prompt);
    setGender(tmpl.recommendedGender);
    setGenre(tmpl.category);
  };

  const saveRecords = (updated: SavedPromptItem[]) => {
    setPromptRecords(updated);
    localStorage.setItem(PROMPT_RECORDS_KEY, JSON.stringify(updated));
  };

  const handleManualBookmark = () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) return;
    const existing = promptRecords.find((item) => item.prompt === nextPrompt);
    if (existing) {
      saveRecords(
        promptRecords.map((item) =>
          item.id === existing.id ? { ...item, isBookmarked: !item.isBookmarked } : item,
        ),
      );
      return;
    }
    const entry: SavedPromptItem = {
      id: Date.now().toString(),
      title: title.trim() || "Untitled",
      prompt: nextPrompt,
      timestamp: Date.now(),
      isBookmarked: true,
    };
    saveRecords([entry, ...promptRecords]);
  };

  const handleToggleBookmark = (id: string) => {
    saveRecords(
      promptRecords.map((item) => (item.id === id ? { ...item, isBookmarked: !item.isBookmarked } : item)),
    );
  };

  const analyzeReferenceFile = async (file: File) => {
    const seq = ++referenceAnalysisSeq.current;
    setIsAnalyzingReference(true);
    setErrorMessage(null);
    const fail = () => {
      if (referenceAnalysisSeq.current === seq) setErrorMessage("Could not read that reference.");
    };
    try {
      let accessToken = "";
      let userId = "";
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data.session?.access_token?.trim() ?? "";
        userId = data.session?.user?.id?.trim() ?? "";
      } catch {
        accessToken = "";
        userId = "";
      }
      if (!accessToken || !userId) {
        fail();
        return;
      }
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const kind = referenceAudioKind(head);
      if (!kind) {
        fail();
        return;
      }
      const contentType = kind === "wav" ? "audio/wav" : "audio/mpeg";
      const safeName = safeReferenceName(file.name || "reference", kind);
      const filePath = `references/${userId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("audio-vault").upload(filePath, file, {
        contentType,
        upsert: true,
      });
      if (uploadError) {
        fail();
        return;
      }
      const { data } = supabase.storage.from("audio-vault").getPublicUrl(filePath);
      const audioUrl = publicReferenceAudioUrl(typeof data?.publicUrl === "string" ? data.publicUrl : "", userId);
      if (!audioUrl) {
        fail();
        return;
      }
      const response = await fetch("/api/reference/audio-to-prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ audioUrl }),
      });
      const raw = await response.text();
      let payload: { success?: boolean; tags?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") payload = parsed as { success?: boolean; tags?: unknown };
      } catch {
        payload = {};
      }
      if (referenceAnalysisSeq.current !== seq) return;
      const tags = typeof payload.tags === "string" ? payload.tags.trim() : "";
      if (!response.ok || payload.success !== true || !tags) {
        setErrorMessage("Could not read that reference.");
        return;
      }
      setPrompt((current) => appendAcousticTags(current, tags));
      setVisualSongDraft((current) => ({
        revision: seq,
        title: current?.title ?? "",
        lyrics: current?.lyrics ?? "",
        tags: appendAcousticTags(current?.tags ?? "", tags),
        pass: "audio",
        acousticTags: tags,
      }));
    } catch {
      if (referenceAnalysisSeq.current === seq) setErrorMessage("Could not read that reference.");
    } finally {
      if (referenceAnalysisSeq.current === seq) setIsAnalyzingReference(false);
    }
  };

  const analyzeVisualFile = async (file: File) => {
    const seq = ++visualAnalysisSeq.current;
    setIsInjectingVisual(true);
    setErrorMessage(null);
    try {
      let accessToken = "";
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data.session?.access_token?.trim() ?? "";
      } catch {
        accessToken = "";
      }
      const body = new FormData();
      body.append("file", file, file.name || "image.png");
      const response = await fetch("/api/reference/visual-injection", {
        method: "POST",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body,
      });
      const raw = await response.text();
      let payload: { success?: boolean; title?: unknown; tags?: unknown; lyrics?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          payload = parsed as { success?: boolean; title?: unknown; tags?: unknown; lyrics?: unknown };
        }
      } catch {
        payload = {};
      }
      if (visualAnalysisSeq.current !== seq) return;
      const nextTitle = typeof payload.title === "string" ? payload.title.trim() : "";
      const nextTags = typeof payload.tags === "string" ? payload.tags.trim() : "";
      const nextLyrics = typeof payload.lyrics === "string" ? payload.lyrics.trim() : "";
      if (!response.ok || payload.success !== true || !nextTitle || !nextTags || !nextLyrics) {
        setErrorMessage("Could not read that image.");
        return;
      }
      setTitle(nextTitle);
      setLyrics(nextLyrics);
      setPrompt(nextTags);
      setVisualSongDraft({ revision: seq, title: nextTitle, lyrics: nextLyrics, tags: nextTags });
    } catch {
      if (visualAnalysisSeq.current === seq) setErrorMessage("Could not read that image.");
    } finally {
      if (visualAnalysisSeq.current === seq) setIsInjectingVisual(false);
    }
  };

  const handleGenerate = async (event: FormEvent | MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (isGenerating) return;
    const styleValue = (prompt ?? "").trim();
    const lyricValue = (lyrics ?? "").trim();
    const duration = trackLength || 180;
    const songTitle = title.trim() || "Feel It in the Rain";
    const dispatchInstrumental = activeTab === "easy";
    if (!dispatchInstrumental && !styleValue && !lyricValue) {
      console.error("HALT: Attempted to submit with empty prompt and lyrics.");
      alert("Generation halted: Lyrics or style prompt are empty. Check your input to avoid burning API credits.");
      return;
    }
    if (!dispatchInstrumental && !lyricValue) {
      console.error("HALT: Attempted to render a vocal master without lyrics.");
      alert("Generation halted: add lyrics before rendering a vocal master.");
      return;
    }
    if (dispatchInstrumental && !styleValue) {
      console.error("HALT: Attempted to submit an instrumental with an empty style prompt.");
      alert("Generation halted: Lyrics or style prompt are empty. Check your input to avoid burning API credits.");
      return;
    }
    const effectivePrompt = styleValue;
    const effectiveTitle = songTitle;
    if (effectivePrompt) {
      const historyEntry: SavedPromptItem = {
        id: Date.now().toString(),
        title: effectiveTitle,
        prompt: effectivePrompt,
        timestamp: Date.now(),
        isBookmarked: false,
      };
      saveRecords([historyEntry, ...promptRecords.filter((item) => item.prompt !== effectivePrompt)]);
    }
    setIsGenerating(true);
    setErrorMessage(null);
    console.log("READY TO DISPATCH:", { title, prompt: styleValue, lyrics: lyricValue, duration });
    console.log("=== SENDING TO BACKEND ===", { prompt: styleValue, lyrics: lyricValue, duration, title: songTitle });
    let ownerId = authUserId?.trim() ?? "";
    let accessToken = "";
    try {
      const { data } = await supabase.auth.getSession();
      const liveId = data.session?.user?.id?.trim() ?? "";
      accessToken = data.session?.access_token?.trim() ?? "";
      if (liveId) ownerId = liveId;
    } catch {
      /* keep the id already held in state */
    }
    if (ownerId && ownerId !== authUserId) setAuthUserId(ownerId);
    try {
      let referenceAudioUrl = "";
      const dispatchReference = activeTab === "custom" && !dispatchInstrumental && attachedReference !== null;
      if (dispatchReference && attachedReference) {
        const rawUrl =
          attachedReference.kind === "file"
            ? await uploadReferenceWav(attachedReference.file, accessToken)
            : attachedReference.url;
        if (!isAudioVaultHttpsUrl(rawUrl)) {
          throw new Error("Reference audio must be a public audio-vault URL.");
        }
        referenceAudioUrl = rawUrl.trim();
      }
      if (referenceAudioUrl) {
        const vocalRes = await fetch("/api/vocals/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            title: songTitle,
            lyrics: lyricValue,
            vocalGender: gender === "female" ? "Female Vocal" : "Male Vocal",
            styleTags: styleValue,
            duration,
            reference_audio_url: referenceAudioUrl,
            ...(selectedCharacter && selectedCharacter.vocalId && !/^https:\/\//i.test(selectedCharacter.vocalId)
              ? { personaId: selectedCharacter.vocalId.trim() }
              : {}),
          }),
        });
        const vocalData = (await vocalRes.json().catch(() => ({}))) as {
          success?: boolean;
          taskId?: string;
          error?: string;
        };
        if (!vocalRes.ok || vocalData.success !== true || !vocalData.taskId) {
          throw new Error(studioPublicError(vocalData.error || "", "Could not attach that reference."));
        }
        const localId = `local-${vocalData.taskId}`;
        setVaultTracks((current) => [
          {
            id: localId,
            title: effectiveTitle,
            genre: effectivePrompt.slice(0, 24),
            duration: "210s",
            status: "Rendering",
            wav_url: "",
            mp3_url: "",
          },
          ...current,
        ]);
        return;
      }
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          prompt: styleValue,
          stylePrompt: styleValue,
          lyrics: lyricValue,
          lyricsText: lyricValue,
          ...(dispatchInstrumental ? {} : { duration }),
          title: songTitle,
          gender,
          isInstrumental: dispatchInstrumental,
          vocalId: selectedCharacter ? selectedCharacter.vocalId : null,
          ...(ownerId ? { userId: ownerId } : {}),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        status?: string;
        taskId?: string;
        error?: string;
        wavUrl?: string;
        mp3Url?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Generation rejected by upstream engine");
      }
      let wavUrl = data.wavUrl ?? "";
      const localId = data.taskId ? `local-${data.taskId}` : `local-${Date.now()}`;
      if (data.status === "pending" && data.taskId) {
        setVaultTracks((current) => [
          {
            id: localId,
            title: effectiveTitle,
            genre: effectivePrompt.slice(0, 24),
            duration: "210s",
            status: "Rendering",
            wav_url: "",
            mp3_url: "",
          },
          ...current,
        ]);
        try {
          const ready = await waitForVaultedTrack(data.taskId);
          wavUrl = ready.wavUrl;
        } catch (waitErr: unknown) {
          setVaultTracks((current) =>
            current.map((row) => (row.id === localId ? { ...row, status: "Failed" } : row)),
          );
          throw waitErr;
        }
      }
      if (!wavUrl) {
        throw new Error(data.error || "Generation rejected by upstream engine");
      }
      setVaultTracks((current) => current.filter((row) => row.id !== localId));
      setVaultRevision((value) => value + 1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "An unexpected error occurred during synthesis.");
    } finally {
      setIsGenerating(false);
    }
  };

  const customCreateDisabled = isGenerating || (!prompt.trim() && !lyrics.trim());
  const styleAssistLabel = prompt.trim() ? "Expand Style" : lyrics.trim() ? "Match Lyrics" : "Surprise Me";
  const lyricsAssistLabel = isLyricsLoading
    ? lyrics.trim()
      ? "Polishing..."
      : "Drafting..."
    : lyrics.trim()
      ? "\u2726 Format & Polish"
      : "Studio Ghostwriter";
  const lyricsAssistDisabled = isLyricsLoading || lyricsAssistCooling;

  const vocalGenderEnabled = activeTab !== "easy";
  const vocalLockTitle =
    activeTab === "easy"
      ? "Vocals disabled in Instrumental mode"
      : activeTab === "custom"
        ? "Vocals disabled in instrumental mode"
        : undefined;
  const vocalsLocked = vocalLockTitle !== undefined;
  const vocalLabel = selectedVocal?.name
    ? `✓ ${selectedVocal.name}`
    : selectedCharacter
      ? `✓ ${selectedCharacter.name}`
      : "+ Vocal";
  const vocalButtonStyle: CSSProperties = selectedVocal || selectedCharacter
    ? {
        ...pillStyle,
        backgroundColor: "rgba(6,182,212,0.15)",
        border: "1px solid #06b6d4",
        color: "#06b6d4",
      }
    : pillStyle;

  return (
    <main
      ref={pageRef}
      className="min-h-screen overflow-y-auto"
      style={{
        minHeight: "100vh",
        color: "#f8fafc",
        colorScheme: "dark",
        position: "relative",
        zIndex: 1,
        background: "transparent",
        padding: "24px 16px 120px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <PatriotGlassStudio>
        <div className="mb-[18px] flex flex-col gap-3 border-b border-[rgba(244,114,182,0.35)] pb-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
          <div className="flex items-center justify-between mb-2">
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-700/60 shadow-inner">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[11px] font-mono tracking-wider font-semibold text-zinc-300 uppercase">
                Hybrid Engine 2.0
              </span>
            </div>
          </div>
          <div
            className="flex flex-row gap-6 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="Studio mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "easy"}
              onClick={() => {
                setActiveTab("easy");
                setIsCharacterModalOpen(false);
              }}
              className="shrink-0 whitespace-nowrap"
              style={modeTabStyle(activeTab === "easy")}
            >
              Instrumental
            </button>
            <button
              type="button"
              role="tab"
              value="custom"
              aria-selected={activeTab === "custom"}
              onClick={() => {
                setActiveTab("custom");
                setIsCharacterModalOpen(false);
              }}
              className="shrink-0 whitespace-nowrap"
              style={{ ...modeTabStyle(activeTab === "custom"), whiteSpace: "nowrap" }}
            >
              Vocals with AI
            </button>
            <button type="button" role="tab" value="vocals" aria-selected={activeTab === "vocals"} onClick={() => setActiveTab("vocals")} className="shrink-0 whitespace-nowrap" style={{ ...modeTabStyle(activeTab === "vocals"), whiteSpace: "nowrap" }}>
              With Vocals
            </button>
          </div>
          </div>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                backgroundColor: "rgba(225, 29, 72, 0.12)",
                border: "1px solid rgba(225, 29, 72, 0.45)",
                borderRadius: 20,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 700,
                color: "#fda4af",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 900 }}>Ⓗ</span>
              <span>
                {isLoadingBalance
                  ? "Syncing..."
                  : `${tokenBalance ?? 0} Hybrid Token${tokenBalance === 1 ? "" : "s"}`}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsBuyTokensOpen(true)}
              style={{
                background: "transparent",
                border: "none",
                color: "#f43f5e",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Buy tokens
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          {attachedReference ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/50 border border-red-500/60 text-xs text-red-200">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 ${isAnalyzingReference ? "animate-ping" : "animate-pulse"}`}
                aria-hidden="true"
              />
              <span className="font-mono truncate max-w-[140px]">
                {isAnalyzingReference
                  ? "Analyzing DNA..."
                  : attachedReference.kind === "file"
                    ? attachedReference.name
                    : attachedReference.title}
              </span>
              {isAnalyzingReference ? null : (
                <button
                  type="button"
                  title="Remove reference"
                  aria-label="Remove reference"
                  onClick={() => setAttachedReference(null)}
                  className="shrink-0 border-0 bg-transparent p-0 text-xs text-red-200"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => setOpenModal("reference")} style={pillStyle}>
              + Reference
            </button>
          )}
          {visualName ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/40 border border-red-500/50 text-xs text-red-200">
              <span
                className={`h-2 w-2 shrink-0 rounded-full bg-red-500 ${isInjectingVisual ? "animate-ping" : "animate-pulse"}`}
                aria-hidden="true"
              />
              <span className="font-mono tracking-wide font-medium truncate max-w-[130px]">
                {isInjectingVisual ? "Processing Visual..." : "Visual Injected"}
              </span>
              {isInjectingVisual ? null : (
                <button
                  type="button"
                  title="Remove visual reference"
                  aria-label="Remove visual reference"
                  onClick={() => setVisualName(null)}
                  className="shrink-0 border-0 bg-transparent p-0 text-xs text-red-200"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftVisualFile(null);
                setOpenModal("visual");
              }}
              style={pillStyle}
            >
              + Visual Injection
            </button>
          )}
          <span
            title={vocalLockTitle}
            style={{ display: "flex" }}
          >
            <button
              type="button"
              disabled={vocalsLocked}
              aria-disabled={vocalsLocked}
              title={vocalLockTitle}
              onClick={() => {
                if (vocalsLocked) return;
                setIsCharacterModalOpen(true);
              }}
              style={{
                ...vocalButtonStyle,
                width: "100%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                cursor: vocalsLocked ? "not-allowed" : "pointer",
                opacity: vocalsLocked ? 0.7 : 1,
              }}
            >
              {vocalsLocked ? <Lock size={14} aria-hidden="true" /> : null}
              {vocalsLocked ? "+ Vocal" : vocalLabel}
            </button>
          </span>
        </div>

        {errorMessage ? (
          <div
            role="status"
            style={{
              backgroundColor: "#3f1d24",
              border: "1px solid #7f1d1d",
              color: "#fecaca",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            <strong>Notice:</strong> {errorMessage}
          </div>
        ) : null}

        {activeTab === "vocals" ? (
          <>
            <VocalStudioTab
              songDraft={visualSongDraft}
              reference={referenceForStudio(
                selectedCharacter,
                selectedVocal,
                attachedReference?.kind === "vault" ? attachedReference : null,
              )}
              vocalReference={
                selectedVocal ? (
                  <ActiveVocalReference vocal={selectedVocal} onRemove={() => setSelectedVocal(null)} />
                ) : null
              }
            />
          </>
        ) : activeTab === "easy" ? (
          <div className="flex flex-col gap-4">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2
                style={{
                  margin: 0,
                  background: "transparent",
                  color: "#94a3b8",
                  WebkitTextFillColor: "#94a3b8",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0,
                  textShadow: "none",
                }}
              >
                Start with a template
              </h2>
              <button
                type="button"
                onClick={() => setIsTemplatesOpen(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#94a3b8",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                View more ›
              </button>
            </div>
            <div
              aria-label="Template carousel"
              style={{
                display: "flex",
                gap: 10,
                overflowX: "auto",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            >
              {MUREKA_TEMPLATES.slice(0, 5).map((tmpl) => (
                <button
                  key={tmpl.id}
                  type="button"
                  onClick={() => handleApplyTemplate(tmpl)}
                  style={{
                    minWidth: 175,
                    maxWidth: 175,
                    flex: "0 0 auto",
                    backgroundColor: "rgba(20, 12, 22, 0.6)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10,
                    padding: 12,
                    cursor: "pointer",
                    textAlign: "left",
                    color: "#f8fafc",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {tmpl.title}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "#94a3b8",
                      lineHeight: 1.35,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {tmpl.subtitle}
                  </div>
                </button>
              ))}
            </div>
            <div
              style={{
                backgroundColor: "rgba(18, 12, 22, 0.65)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  disabled={isVibeEnhancing}
                  aria-busy={isVibeEnhancing}
                  onClick={() => void handleEnhanceVibe()}
                  className={badgeActionClass}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {isVibeEnhancing ? "Enhancing..." : "Enhance Vibe"}
                </button>
              </div>
              <input
                aria-label="What's the vibe?"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={VIBE_PLACEHOLDER}
                style={{
                  width: "100%",
                  background: "transparent",
                  backgroundColor: "transparent",
                  border: "none",
                  color: "#f8fafc",
                  fontSize: 14,
                  outline: "none",
                  padding: 0,
                }}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <VocalGenderCard vocalsEnabled={vocalGenderEnabled} gender={gender} onChange={setGender} />
              <div style={cardStyle}>
                <DurationSlider maxSeconds={360} value={trackLength} onChange={setTrackLength} />
              </div>
            </div>
            <button
              type="button"
              disabled={isGenerating || !prompt.trim()}
              onClick={(event) => void handleGenerate(event)}
              className={renderButtonClass}
            >
              {isGenerating ? "Synthesizing & Vaulting..." : "Render Master Record"}
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void handleGenerate(event)} className="flex flex-col gap-4">
            <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px" }}>
              <input
                type="text"
                aria-label="Song title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Enter song title"
                maxLength={50}
                style={{ backgroundColor: "transparent", border: "none", color: "#f8fafc", outline: "none", fontSize: 14, width: "80%" }}
              />
              <span style={{ fontSize: 12, color: "#64748b" }}>{title.length}/50</span>
            </div>
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Lyrics & Structure</span>
                <button
                  type="button"
                  disabled={lyricsAssistDisabled}
                  aria-label={lyrics.trim() ? "Format and polish lyrics" : undefined}
                  onClick={() => void handleLyricsAssist()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-950/30 text-xs font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {lyricsAssistLabel}
                </button>
              </div>
              <textarea
                aria-label="Lyrics"
                value={lyrics}
                onChange={(event) => setLyrics(event.target.value)}
                placeholder="Enter lyrics..."
                rows={5}
                style={fieldStyle}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setLyrics("")}
                  aria-label="Clear lyrics"
                  title="Clear lyrics"
                  style={{ backgroundColor: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                >
                  🗑️
                </button>
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Musical Style</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={isAiLoading}
                    onClick={() => void handleEnhanceStyle()}
                    className={badgeActionClass}
                  >
                    {isAiLoading ? "Designing..." : styleAssistLabel}
                  </button>
                  <button type="button" onClick={() => setIsTemplatesOpen(true)} className={secondaryActionClass}>
                    Templates
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPromptRecords(readPromptRecords());
                      setIsMyPromptsOpen(true);
                    }}
                    className={secondaryActionClass}
                  >
                    Saved
                  </button>
                </div>
              </div>
              <textarea
                aria-label="Style"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Genre, mood, or instruments — or try Match Lyrics or Surprise Me"
                maxLength={1000}
                rows={4}
                style={fieldStyle}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10, fontSize: 12, color: "#64748b" }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={handleManualBookmark}
                    title="Bookmark this prompt"
                    aria-label="Bookmark this prompt"
                    style={{ backgroundColor: "transparent", border: "none", color: "#f43f5e", cursor: "pointer", fontSize: 14 }}
                  >
                    🔖
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt("")}
                    aria-label="Clear style"
                    style={{ backgroundColor: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                  >
                    🗑️
                  </button>
                </div>
                <span>{prompt.length}/1000</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <VocalGenderCard vocalsEnabled={vocalGenderEnabled} gender={gender} onChange={setGender} />
              <div style={{ ...cardStyle, flex: "1 1 280px" }}>
                <DurationSlider value={trackLength} onChange={setTrackLength} />
              </div>
            </div>

            <button
              type="submit"
              disabled={customCreateDisabled}
              className={renderButtonClass}
            >
              {isGenerating ? "Synthesizing & Vaulting..." : "Render Master Record"}
            </button>
          </form>
        )}
        </PatriotGlassStudio>

        <section style={{ ...cardStyle, marginTop: 24 }} aria-label="Your Audio Vault">
          <AudioVaultList
            revision={vaultRevision}
            pending={vaultTracks
              .filter((row) => row.status === "Rendering" || row.status === "Failed")
              .map((row) => ({ id: row.id, title: row.title, status: row.status, genre: row.genre }))}
          />
        </section>

        <TemplatesModal isOpen={isTemplatesOpen} onClose={() => setIsTemplatesOpen(false)} onSelectTemplate={handleApplyTemplate} />
        <BuyTokensModal isOpen={isBuyTokensOpen} onClose={() => setIsBuyTokensOpen(false)} />

        {openModal === "reference" ? (
          <div
            role="presentation"
            onClick={() => setOpenModal(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              background: "rgba(0,0,0,0.8)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Reference"
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 440,
                background: "#141018",
                color: "#f8fafc",
                border: "1px solid rgba(225, 29, 72, 0.4)",
                borderRadius: 12,
                padding: 22,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Reference</h2>
                <button
                  type="button"
                  onClick={() => setOpenModal(null)}
                  aria-label="Close reference"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#f8fafc",
                    fontSize: 18,
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45 }}>
                Add a reference recording. Nothing is uploaded until you choose to send it.
              </p>
              <input
                id="ref-audio-upload"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) setDraftReferenceFile(file);
                }}
                style={{ display: "none" }}
              />
              <label
                htmlFor="ref-audio-upload"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  border: "1px dashed rgba(225, 29, 72, 0.5)",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 8,
                  padding: "24px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <span aria-hidden="true">🎧</span>
                <span>{draftReferenceFile ? `Selected: ${draftReferenceFile.name}` : "Click here to add a reference"}</span>
                <span style={{ color: "#64748b", fontSize: 11 }}>Supports MP3, WAV, FLAC, M4A</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  const file = draftReferenceFile;
                  if (file) {
                    setAttachedReference({
                      kind: "file",
                      name: file.name || "reference.wav",
                      file,
                    });
                    setIsAnalyzingReference(true);
                    setOpenModal(null);
                    void analyzeReferenceFile(file);
                    return;
                  }
                  setOpenModal(null);
                }}
                style={{
                  width: "100%",
                  background: "linear-gradient(90deg, #e11d48, #be123c)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 0",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        {openModal === "visual" ? (
          <div
            role="presentation"
            onClick={() => setOpenModal(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              background: "rgba(0,0,0,0.8)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Visual Injection"
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 440,
                background: "#141018",
                color: "#f8fafc",
                border: "1px solid rgba(225, 29, 72, 0.4)",
                borderRadius: 12,
                padding: 22,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Visual Injection</h2>
                <button
                  type="button"
                  onClick={() => setOpenModal(null)}
                  aria-label="Close visual"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#f8fafc",
                    fontSize: 18,
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45 }}>
                Add a cover image. Nothing is sent until you choose Done.
              </p>
              <input
                id="visual-injection-upload"
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) setDraftVisualFile(file);
                }}
                style={{ display: "none" }}
              />
              <label
                htmlFor="visual-injection-upload"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  border: "1px dashed rgba(225, 29, 72, 0.5)",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 8,
                  padding: "24px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <span>{draftVisualFile ? draftVisualFile.name : "Click here to add an image"}</span>
                <span style={{ color: "#64748b", fontSize: 11 }}>PNG, JPG, or WebP</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  const file = draftVisualFile;
                  if (!file) {
                    setOpenModal(null);
                    return;
                  }
                  setVisualName(file.name || "image.png");
                  setIsInjectingVisual(true);
                  setOpenModal(null);
                  void analyzeVisualFile(file);
                }}
                style={{
                  width: "100%",
                  background: "linear-gradient(90deg, #e11d48, #be123c)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 0",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        <MyPromptsModal
          isOpen={isMyPromptsOpen}
          onClose={() => setIsMyPromptsOpen(false)}
          items={promptRecords}
          onSelectPrompt={(loadedPrompt) => setPrompt(loadedPrompt)}
          onToggleBookmark={handleToggleBookmark}
        />
        <CharacterModal
          isOpen={isCharacterModalOpen}
          onClose={() => setIsCharacterModalOpen(false)}
          characters={userCharacters}
          selectedCharacterId={selectedCharacter?.id || null}
          selectedSourceUrl={selectedVocal?.url ?? null}
          onSelectCharacter={(char) => setSelectedCharacter(char)}
          onSelectVocal={setSelectedVocal}
        />
      </div>
      <StudioFooter />
    </main>
  );
}
