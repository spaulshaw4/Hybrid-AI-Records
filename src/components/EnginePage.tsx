import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";

import CharacterModal, { type VocalCharacter } from "@/components/studio/CharacterModal";
import LyricEditorModal from "@/components/studio/LyricEditorModal";
import MyPromptsModal, { type SavedPromptItem } from "@/components/studio/MyPromptsModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import VocalUpgradeModal from "@/components/studio/VocalUpgradeModal";
import { MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";

const PROMPT_RECORDS_KEY = "hybrid_prompt_records";
const FALLBACK_PROMPT = "Heavy dynamic acoustic rock with raspy vocals";
const VAULT_EMPTY = "No ready masters yet. Create a track and it will show up here.";

type StudioModal = "reference" | "remix" | null;

interface VaultTrack {
  id: string;
  title: string;
  genre: string;
  duration: string;
  status: string;
  wav_url: string;
  mp3_url: string;
}

const cardStyle: CSSProperties = {
  backgroundColor: "#121826",
  border: "1px solid #1e293b",
  borderRadius: 10,
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

function tracksFromPayload(data: unknown): VaultTrack[] {
  const list =
    data && typeof data === "object" && Array.isArray((data as { tracks?: unknown }).tracks)
      ? (data as { tracks: unknown[] }).tracks
      : [];
  return list.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id =
      typeof row.id === "string" && row.id
        ? row.id
        : typeof row.task_id === "string" && row.task_id
          ? row.task_id
          : `vault-${index}`;
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled Master";
    const genre =
      typeof row.genre === "string" ? row.genre : String(typeof row.prompt === "string" ? row.prompt : "").slice(0, 24);
    return [
      {
        id,
        title,
        genre,
        duration: typeof row.duration === "string" && row.duration ? row.duration : "210s",
        status: typeof row.status === "string" && row.status ? row.status : "Ready",
        wav_url: typeof row.wav_url === "string" ? row.wav_url : "",
        mp3_url: typeof row.mp3_url === "string" ? row.mp3_url : "",
      },
    ];
  });
}

function DarkModal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(8, 2, 6, 0.78)",
        backgroundColor: "rgba(8, 2, 6, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          background: "#150913",
          backgroundColor: "#150913",
          color: "#f8fafc",
          colorScheme: "dark",
          border: "1px solid #6b2144",
          borderRadius: 12,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.45)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f8fafc" }}>{label}</h2>
        {children}
        <button
          type="button"
          onClick={onClose}
          style={{
            backgroundColor: "#3b1024",
            color: "#f8fafc",
            border: "1px solid #9f1239",
            borderRadius: 8,
            padding: "10px 0",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export function EnginePage() {
  const [activeTab, setActiveTab] = useState<"custom" | "easy">("easy");
  const [isInstrumental, setIsInstrumental] = useState(false);
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
  const [isCharacterModalOpen, setIsCharacterModalOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [hasProLicense, setHasProLicense] = useState(false);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isLyricModalOpen, setIsLyricModalOpen] = useState(false);
  const [openModal, setOpenModal] = useState<StudioModal>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isEnhanceMenuOpen, setIsEnhanceMenuOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const enhanceMenuRef = useRef<HTMLDivElement>(null);
  const [isMyPromptsOpen, setIsMyPromptsOpen] = useState(false);
  const [promptRecords, setPromptRecords] = useState<SavedPromptItem[]>([]);
  const [vaultTracks, setVaultTracks] = useState<VaultTrack[]>([]);

  useEffect(() => {
    setPromptRecords(readPromptRecords());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchVault() {
      try {
        const res = await fetch("/api/vault");
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (cancelled) return;
        setVaultTracks(tracksFromPayload(data));
      } catch {
        // Vault stays on the empty copy when the list cannot be loaded.
      }
    }
    void fetchVault();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isEnhanceMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!enhanceMenuRef.current?.contains(event.target as Node)) {
        setIsEnhanceMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsEnhanceMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isEnhanceMenuOpen]);

  const handleEnhanceSelection = async (type: "enhance_match_vibe" | "enhance_surprise_me") => {
    if (isAiLoading) return;
    setIsEnhanceMenuOpen(false);
    setIsAiLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: type, text: prompt.trim(), title }),
      });
      const data = (await res.json()) as { success?: boolean; result?: string; error?: string };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "AI request failed");
      }
      setPrompt(data.result ?? "");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "AI request failed");
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleApplyTemplate = (tmpl: TrackTemplate) => {
    setPrompt(tmpl.prompt);
    setGender(tmpl.recommendedGender);
    setIsInstrumental(tmpl.isInstrumentalDefault);
    setGenre(tmpl.category);
    setActiveTab("custom");
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

  const handleGenerate = async (event: FormEvent) => {
    event.preventDefault();
    if (isGenerating) return;
    const effectivePrompt = prompt.trim() || FALLBACK_PROMPT;
    const effectiveTitle = title.trim() || "Untitled Master";
    const historyEntry: SavedPromptItem = {
      id: Date.now().toString(),
      title: effectiveTitle,
      prompt: effectivePrompt,
      timestamp: Date.now(),
      isBookmarked: false,
    };
    saveRecords([historyEntry, ...promptRecords.filter((item) => item.prompt !== effectivePrompt)]);
    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: effectiveTitle,
          prompt: effectivePrompt,
          lyrics: isInstrumental ? "" : lyrics,
          gender,
          isInstrumental,
          vocalId: selectedCharacter ? selectedCharacter.vocalId : null,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        wavUrl?: string;
        mp3Url?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Generation rejected by upstream engine");
      }
      const created: VaultTrack = {
        id: `local-${Date.now()}`,
        title: effectiveTitle,
        genre: effectivePrompt.slice(0, 24),
        duration: "210s",
        status: "Ready",
        wav_url: data.wavUrl ?? "",
        mp3_url: data.mp3Url ?? "",
      };
      setVaultTracks((current) => [created, ...current]);
      try {
        const vaultRes = await fetch("/api/vault");
        if (vaultRes.ok) {
          const vaultData: unknown = await vaultRes.json();
          const fetched = tracksFromPayload(vaultData);
          setVaultTracks((current) => {
            if (fetched.length === 0) return current;
            return fetched;
          });
        }
      } catch {
        // Keep the row just created when the vault list cannot refresh.
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "An unexpected error occurred during synthesis.");
    } finally {
      setIsGenerating(false);
    }
  };

  const vocalLabel = selectedCharacter ? `✓ ${selectedCharacter.name}` : "+ Vocal";
  const vocalButtonStyle: CSSProperties = selectedCharacter
    ? {
        ...pillStyle,
        backgroundColor: "rgba(6,182,212,0.15)",
        border: "1px solid #06b6d4",
        color: "#06b6d4",
      }
    : pillStyle;

  return (
    <main
      style={{
        minHeight: "100vh",
        color: "#f8fafc",
        colorScheme: "dark",
        position: "relative",
        zIndex: 1,
        backgroundColor: "#1a0610",
        backgroundImage:
          "radial-gradient(ellipse 85% 70% at 0% 0%, rgba(168, 85, 247, 0.78) 0%, rgba(88, 28, 135, 0.42) 34%, transparent 68%), radial-gradient(ellipse 80% 65% at 100% 8%, rgba(225, 29, 72, 0.82) 0%, rgba(136, 19, 55, 0.48) 38%, transparent 70%), radial-gradient(ellipse 70% 50% at 48% 100%, rgba(157, 23, 77, 0.55) 0%, transparent 62%), linear-gradient(165deg, #3b0764 0%, #4c0519 42%, #140810 100%)",
        padding: "28px 16px 48px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            borderBottom: "1px solid rgba(244, 114, 182, 0.35)",
            paddingBottom: 10,
            marginBottom: 18,
          }}
        >
          <div style={{ display: "flex", gap: 24 }} role="tablist" aria-label="Studio mode">
            <button type="button" role="tab" aria-selected={activeTab === "easy"} onClick={() => setActiveTab("easy")} style={modeTabStyle(activeTab === "easy")}>
              Easy
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "custom"} onClick={() => setActiveTab("custom")} style={modeTabStyle(activeTab === "custom")}>
              Custom
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              aria-label="1 Token"
              style={{
                backgroundColor: "rgba(190, 18, 60, 0.22)",
                border: "1px solid #e11d48",
                borderRadius: 20,
                color: "#fecdd3",
                fontSize: 12,
                fontWeight: 700,
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              1 Token
            </span>
            <button
              type="button"
              style={{
                backgroundColor: "transparent",
                border: "none",
                color: "#fda4af",
                fontSize: 12,
                fontWeight: 700,
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
          <button type="button" onClick={() => setOpenModal("reference")} style={pillStyle}>
            + Reference
          </button>
          <button type="button" onClick={() => setOpenModal("remix")} style={pillStyle}>
            + Remix
          </button>
          <button type="button" onClick={() => setIsCharacterModalOpen(true)} style={vocalButtonStyle}>
            {vocalLabel}
          </button>
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

        {activeTab === "easy" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {MUREKA_TEMPLATES.map((tmpl) => (
              <article key={tmpl.id} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{tmpl.title}</h2>
                  <p style={{ margin: "6px 0 0", fontSize: 12, color: "#94a3b8", lineHeight: 1.4 }}>{tmpl.subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleApplyTemplate(tmpl)}
                  style={{
                    marginTop: "auto",
                    backgroundColor: "#9f1239",
                    color: "#ffffff",
                    border: "1px solid #4c0519",
                    borderRadius: 8,
                    padding: "8px 0",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Load into Custom
                </button>
              </article>
            ))}
          </div>
        ) : (
          <form onSubmit={(event) => void handleGenerate(event)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{isInstrumental ? "Lyrics disabled" : "Lyrics"}</span>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#94a3b8", cursor: "pointer" }}>
                  Instrumental
                  <input
                    type="checkbox"
                    checked={isInstrumental}
                    onChange={(event) => setIsInstrumental(event.target.checked)}
                    style={{ accentColor: "#e11d48", width: 16, height: 16, cursor: "pointer" }}
                  />
                </label>
              </div>
              {isInstrumental ? null : (
                <>
                  <textarea
                    aria-label="Lyrics"
                    value={lyrics}
                    onChange={(event) => setLyrics(event.target.value)}
                    placeholder="Enter lyrics..."
                    rows={5}
                    style={fieldStyle}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10 }}>
                    <div style={{ display: "flex", gap: 14 }}>
                      <button
                        type="button"
                        onClick={() => setIsLyricModalOpen(true)}
                        style={{ background: "transparent", border: "none", color: "#f43f5e", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600 }}
                      >
                        ✨ Optimize
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsLyricModalOpen(true)}
                        style={{ background: "transparent", border: "none", color: "#f43f5e", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600 }}
                      >
                        📋 Generate Lyrics
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLyrics("")}
                      aria-label="Clear lyrics"
                      style={{ backgroundColor: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                    >
                      🗑️
                    </button>
                  </div>
                </>
              )}
            </div>

            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Style</span>
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
              </div>
              <textarea
                aria-label="Style"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Enter style, mood, instrument, etc. to control the generated music"
                maxLength={1000}
                rows={4}
                style={fieldStyle}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10, fontSize: 12, color: "#64748b" }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <div ref={enhanceMenuRef} style={{ position: "relative" }}>
                    <button
                      type="button"
                      disabled={isAiLoading}
                      aria-expanded={isEnhanceMenuOpen}
                      aria-haspopup="menu"
                      onClick={() => setIsEnhanceMenuOpen((open) => !open)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#f43f5e",
                        cursor: isAiLoading ? "not-allowed" : "pointer",
                        padding: 0,
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {isAiLoading ? "🪄 Writing..." : "🪄 Enhance"}
                    </button>
                    {isEnhanceMenuOpen ? (
                      <div
                        role="menu"
                        aria-label="Enhance style"
                        style={{
                          position: "absolute",
                          bottom: "calc(100% + 8px)",
                          left: 0,
                          background: "#16131c",
                          backgroundColor: "#16131c",
                          border: "1px solid rgba(255,255,255,0.12)",
                          borderRadius: 10,
                          width: 230,
                          zIndex: 40,
                          overflow: "hidden",
                          boxShadow: "0 12px 28px rgba(0, 0, 0, 0.45)",
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void handleEnhanceSelection("enhance_match_vibe")}
                          onMouseEnter={(event) => {
                            event.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)";
                          }}
                          onMouseLeave={(event) => {
                            event.currentTarget.style.backgroundColor = "transparent";
                          }}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 2,
                            width: "100%",
                            textAlign: "left",
                            background: "transparent",
                            backgroundColor: "transparent",
                            border: "none",
                            color: "#f8fafc",
                            padding: "10px 12px",
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 700 }}>🪄 Match my vibe</span>
                          <span style={{ fontSize: 11, color: "#a1a1aa" }}>Polish and expand your style</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void handleEnhanceSelection("enhance_surprise_me")}
                          onMouseEnter={(event) => {
                            event.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)";
                          }}
                          onMouseLeave={(event) => {
                            event.currentTarget.style.backgroundColor = "transparent";
                          }}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 2,
                            width: "100%",
                            textAlign: "left",
                            background: "transparent",
                            backgroundColor: "transparent",
                            border: "none",
                            color: "#f8fafc",
                            padding: "10px 12px",
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 700 }}>✨ Surprise me</span>
                          <span style={{ fontSize: 11, color: "#a1a1aa" }}>Try a fresh, unexpected twist</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsTemplatesOpen(true)}
                    style={{ backgroundColor: "transparent", border: "none", color: "#f9a8d4", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600 }}
                  >
                    📋 Templates
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsMyPromptsOpen(true)}
                    style={{
                      backgroundColor: "transparent",
                      border: "none",
                      color: "#f43f5e",
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 12,
                    }}
                  >
                    🔖 My prompts
                  </button>
                </div>
                <span>{prompt.length}/1000</span>
              </div>
            </div>

            {isInstrumental ? null : (
              <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>Vocal Gender</span>
                <div style={{ display: "flex", backgroundColor: "#0b0f19", borderRadius: 6, padding: 3, border: "1px solid #1e293b" }}>
                  <button
                    type="button"
                    aria-pressed={gender === "female"}
                    onClick={() => setGender("female")}
                    style={{
                      padding: "5px 18px",
                      backgroundColor: gender === "female" ? "#9f1239" : "transparent",
                      color: gender === "female" ? "#ffffff" : "#94a3b8",
                      border: "none",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Female
                  </button>
                  <button
                    type="button"
                    aria-pressed={gender === "male"}
                    onClick={() => setGender("male")}
                    style={{
                      padding: "5px 18px",
                      backgroundColor: gender === "male" ? "#9f1239" : "transparent",
                      color: gender === "male" ? "#ffffff" : "#94a3b8",
                      border: "none",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Male
                  </button>
                </div>
              </div>
            )}

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

            <button
              type="submit"
              disabled={isGenerating}
              style={{
                padding: "14px 0",
                background: isGenerating ? "#1e293b" : "linear-gradient(90deg, #9f1239 0%, #7e22ce 100%)",
                backgroundColor: isGenerating ? "#1e293b" : "#9f1239",
                color: "#ffffff",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 700,
                cursor: isGenerating ? "not-allowed" : "pointer",
              }}
            >
              {isGenerating ? "Synthesizing & Vaulting..." : "🎵 Create"}
            </button>
          </form>
        )}

        <section style={{ ...cardStyle, marginTop: 24 }} aria-label="Your Audio Vault">
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Your Audio Vault</h3>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "#94a3b8" }}>
            Permanent dual delivery. Ready WAV and MP3 masters stay in this list.
          </p>
          {vaultTracks.length === 0 ? (
            <p style={{ margin: "12px 0 0", fontSize: 13, color: "#94a3b8" }}>{VAULT_EMPTY}</p>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              {vaultTracks.map((track) => {
                const src = track.mp3_url || track.wav_url;
                return (
                  <li key={track.id} style={{ borderTop: "1px solid #1e293b", paddingTop: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                      <strong style={{ fontSize: 14 }}>{track.title}</strong>
                      <span style={{ fontSize: 12, color: "#86efac" }}>{track.status}</span>
                    </div>
                    <p style={{ margin: "4px 0 8px", fontSize: 12, color: "#94a3b8" }}>
                      {track.genre || "Untitled style"} · {track.duration}
                    </p>
                    {src ? <audio controls preload="none" src={src} style={{ width: "100%" }} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <TemplatesModal isOpen={isTemplatesOpen} onClose={() => setIsTemplatesOpen(false)} onSelectTemplate={handleApplyTemplate} />
        <LyricEditorModal
          isOpen={isLyricModalOpen}
          onClose={() => setIsLyricModalOpen(false)}
          currentTitle={title}
          currentPrompt={prompt}
          initialLyrics={lyrics}
          onApplyLyrics={(newLyrics) => setLyrics(newLyrics)}
        />

        {openModal === "reference" ? (
          <DarkModal label="Reference" onClose={() => setOpenModal(null)}>
            <p style={{ margin: 0, fontSize: 13, color: "#e9d5ff" }}>
              Add a reference recording. Nothing is uploaded until you choose to send it.
            </p>
            <input
              type="file"
              accept="audio/*"
              aria-label="Reference audio file"
              style={{
                color: "#f8fafc",
                colorScheme: "dark",
                backgroundColor: "#150913",
                border: "1px solid #4c1d3a",
                borderRadius: 8,
                padding: 8,
              }}
            />
          </DarkModal>
        ) : null}

        {openModal === "remix" ? (
          <DarkModal label="Remix" onClose={() => setOpenModal(null)}>
            <p style={{ margin: 0, fontSize: 13, color: "#e9d5ff" }}>
              Describe how the new master should move. The original stays in the vault.
            </p>
            <textarea
              aria-label="Remix direction"
              rows={4}
              placeholder="Harder drums, keep the vocal, half-time chorus"
              style={{
                ...fieldStyle,
                backgroundColor: "#1c0c14",
                border: "1px solid #4c1d3a",
                borderRadius: 8,
                padding: 8,
              }}
            />
          </DarkModal>
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
          onSelectCharacter={(char) => setSelectedCharacter(char)}
          onOpenUpgradeModal={() => {
            setIsCharacterModalOpen(false);
            setIsUpgradeModalOpen(true);
          }}
          hasProLicense={hasProLicense}
        />
        <VocalUpgradeModal
          isOpen={isUpgradeModalOpen}
          onClose={() => setIsUpgradeModalOpen(false)}
          onCompleteCheckout={() => {
            setHasProLicense(true);
            setIsUpgradeModalOpen(false);
            setIsCharacterModalOpen(true);
          }}
        />
      </div>
    </main>
  );
}
