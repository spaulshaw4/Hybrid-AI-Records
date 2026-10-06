import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { ReferenceModal } from "@/components/studio/ReferenceModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";

const SAVED_PROMPTS_KEY = "hybrid_saved_prompts";
const FALLBACK_PROMPT = "Dynamic studio arrangement with balanced rhythm and master polish";
const VAULT_SUBTITLE = "Permanent dual delivery. Ready WAV and MP3 masters stay in this list.";
const VAULT_EMPTY = "No ready masters yet. Create a track and it will show up here.";

type AiAction = "enhance_style" | "optimize_lyrics" | "generate_lyrics";
type VaultStatus = "Ready" | "Failed";

interface VaultRow {
  id: string;
  title: string;
  prompt: string;
  status: VaultStatus;
  wavUrl: string;
  mp3Url: string;
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
  padding: "10px 0",
  color: "#cbd5e1",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

function modeTabStyle(active: boolean): CSSProperties {
  return {
    backgroundColor: "transparent",
    border: "none",
    color: active ? "#06b6d4" : "#94a3b8",
    fontWeight: 700,
    fontSize: 15,
    borderBottom: active ? "2px solid #06b6d4" : "2px solid transparent",
    paddingBottom: 6,
    cursor: "pointer",
  };
}

function textButtonStyle(disabled: boolean): CSSProperties {
  return {
    backgroundColor: "transparent",
    border: "none",
    color: disabled ? "#475569" : "#94a3b8",
    cursor: disabled ? "not-allowed" : "pointer",
    padding: 0,
    fontSize: 12,
    fontWeight: 600,
  };
}

function readSavedPrompts(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_PROMPTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function vaultStatus(value: unknown): VaultStatus {
  return value === "Failed" ? "Failed" : "Ready";
}

function rowsFromVaultPayload(data: unknown): VaultRow[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { tracks?: unknown }).tracks)
      ? (data as { tracks: unknown[] }).tracks
      : [];
  return list.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled Master";
    return [
      {
        id: typeof row.id === "string" && row.id ? row.id : `vault-${index}`,
        title,
        prompt: typeof row.prompt === "string" ? row.prompt : "",
        status: vaultStatus(row.status),
        wavUrl: typeof row.wavUrl === "string" ? row.wavUrl : typeof row.wav_url === "string" ? row.wav_url : "",
        mp3Url: typeof row.mp3Url === "string" ? row.mp3Url : typeof row.mp3_url === "string" ? row.mp3_url : "",
      },
    ];
  });
}

export function EnginePage() {
  const [activeTab, setActiveTab] = useState<"custom" | "easy">("easy");
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isReferenceOpen, setIsReferenceOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedPrompts, setSavedPrompts] = useState<string[]>([]);
  const [vaultRows, setVaultRows] = useState<VaultRow[]>([]);
  const [hideFailed, setHideFailed] = useState(true);
  const [nowPlayingUrl, setNowPlayingUrl] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const rowAudio = useRef<Record<string, HTMLAudioElement | null>>({});

  useEffect(() => {
    setSavedPrompts(readSavedPrompts());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchVault() {
      try {
        const res = await fetch("/api/vault");
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (cancelled) return;
        const rows = rowsFromVaultPayload(data);
        setVaultRows((current) => (current.length > 0 ? current : rows));
      } catch {
        // No list endpoint — local rows after Create are enough.
      }
    }
    void fetchVault();
    return () => {
      cancelled = true;
    };
  }, []);

  const triggerDownload = async (fileUrl: string, fileName: string) => {
    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(fileUrl, "_blank");
    }
  };

  const handleAiAction = async (action: AiAction) => {
    if (isAiLoading) return;
    if (action === "optimize_lyrics" && !lyrics.trim()) return;
    if (action === "enhance_style" && !prompt.trim()) return;
    const text = action === "optimize_lyrics" ? lyrics : prompt;
    setIsAiLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text, title, genre }),
      });
      const data = (await res.json()) as { success?: boolean; result?: string; error?: string };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "AI request failed");
      }
      const result = (data.result ?? "").trim();
      if (action === "enhance_style") setPrompt(result.slice(0, 1000));
      else setLyrics(result);
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

  const savePrompt = () => {
    const next = prompt.trim();
    if (!next) return;
    const updated = [next, ...savedPrompts.filter((item) => item !== next)];
    setSavedPrompts(updated);
    localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(updated));
  };

  const loadSavedPrompt = () => {
    if (savedPrompts.length === 0) return;
    setPrompt(savedPrompts[0] ?? "");
  };

  const toggleRowAudio = (row: VaultRow) => {
    const src = row.mp3Url || row.wavUrl;
    const node = rowAudio.current[row.id];
    if (!src || !node) return;
    if (playingId === row.id && !node.paused) {
      node.pause();
      setPlayingId(null);
      return;
    }
    for (const [id, audio] of Object.entries(rowAudio.current)) {
      if (id !== row.id) audio?.pause();
    }
    void node.play();
    setPlayingId(row.id);
  };

  const handleGenerate = async (event: FormEvent) => {
    event.preventDefault();
    if (isGenerating) return;
    const lyricPayload = isInstrumental ? "" : lyrics.trim();
    if (!prompt.trim() && !lyricPayload) {
      setErrorMessage("Add a style prompt or lyrics before creating.");
      return;
    }
    const sentPrompt = prompt.trim() || FALLBACK_PROMPT;
    const sentTitle = title.trim() || "Untitled Master";
    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: sentTitle,
          prompt: sentPrompt,
          lyrics: lyricPayload,
          gender,
          isInstrumental,
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
      const wavUrl = data.wavUrl ?? "";
      const mp3Url = data.mp3Url ?? "";
      const row: VaultRow = {
        id: `local-${Date.now()}`,
        title: sentTitle,
        prompt: sentPrompt,
        status: "Ready",
        wavUrl,
        mp3Url,
      };
      setVaultRows((current) => [row, ...current]);
      setNowPlayingUrl(mp3Url || wavUrl || null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "An unexpected error occurred during synthesis.");
    } finally {
      setIsGenerating(false);
    }
  };

  const visibleRows = hideFailed ? vaultRows.filter((row) => row.status === "Ready") : vaultRows;
  const optimizeDisabled = isAiLoading || !lyrics.trim();
  const generateDisabled = isAiLoading;
  const enhanceDisabled = isAiLoading || !prompt.trim();

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#0b0f19",
        color: "#f8fafc",
        colorScheme: "dark",
        padding: "28px 16px 120px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            borderBottom: "1px solid #1e293b",
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
              aria-label="1 Tokens"
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.15)",
                border: "1px solid #ef4444",
                borderRadius: 20,
                color: "#f87171",
                fontSize: 12,
                fontWeight: 700,
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              1 Tokens
            </span>
            <button
              type="button"
              style={{
                backgroundColor: "transparent",
                border: "none",
                color: "#f87171",
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
          <button type="button" onClick={() => setIsReferenceOpen(true)} style={pillStyle}>
            + Reference
          </button>
          <button type="button" style={pillStyle}>
            + Remix
          </button>
          <button type="button" style={pillStyle}>
            + Vocal 🔒
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
                    backgroundColor: "#0284c7",
                    color: "#ffffff",
                    border: "1px solid #1e293b",
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
                    style={{ accentColor: "#0284c7", width: 16, height: 16, cursor: "pointer" }}
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
                    style={{
                      width: "100%",
                      backgroundColor: "transparent",
                      border: "none",
                      color: "#f8fafc",
                      outline: "none",
                      resize: "none",
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10 }}>
                    <div style={{ display: "flex", gap: 14 }}>
                      <button type="button" disabled={optimizeDisabled} onClick={() => void handleAiAction("optimize_lyrics")} style={textButtonStyle(optimizeDisabled)}>
                        ✨ Optimize
                      </button>
                      <button type="button" disabled={generateDisabled} onClick={() => void handleAiAction("generate_lyrics")} style={textButtonStyle(generateDisabled)}>
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
                    onClick={savePrompt}
                    aria-label="Bookmark prompt"
                    style={{ backgroundColor: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
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
                style={{
                  width: "100%",
                  backgroundColor: "transparent",
                  border: "none",
                  color: "#f8fafc",
                  outline: "none",
                  resize: "none",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10, fontSize: 12, color: "#64748b" }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <button type="button" disabled={enhanceDisabled} onClick={() => void handleAiAction("enhance_style")} style={textButtonStyle(enhanceDisabled)}>
                    ✨ Enhance
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsTemplatesOpen(true)}
                    style={{ backgroundColor: "transparent", border: "none", color: "#38bdf8", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600 }}
                  >
                    📋 Templates
                  </button>
                  <button type="button" onClick={loadSavedPrompt} style={textButtonStyle(savedPrompts.length === 0)}>
                    🔖 Saved ({savedPrompts.length})
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
                      backgroundColor: gender === "female" ? "#0284c7" : "transparent",
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
                      backgroundColor: gender === "male" ? "#0284c7" : "transparent",
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
                background: isGenerating ? "#1e293b" : "linear-gradient(90deg, #0284c7 0%, #06b6d4 100%)",
                backgroundColor: isGenerating ? "#1e293b" : "#0284c7",
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

        {nowPlayingUrl ? (
          <section style={{ ...cardStyle, marginTop: 24 }} aria-label="Now Playing Master Audio">
            <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>Now Playing Master Audio</h3>
            <audio controls autoPlay src={nowPlayingUrl} style={{ width: "100%" }} />
          </section>
        ) : null}

        <section style={{ ...cardStyle, marginTop: 24 }} aria-label="Your Audio Vault">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Your Audio Vault</h3>
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#94a3b8" }}>{VAULT_SUBTITLE}</p>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={hideFailed}
                onChange={(event) => setHideFailed(event.target.checked)}
                style={{ accentColor: "#0284c7" }}
              />
              Hide failed
            </label>
          </div>
          {visibleRows.length === 0 ? (
            <p style={{ margin: "12px 0 0", fontSize: 13, color: "#94a3b8" }}>{VAULT_EMPTY}</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13 }}>
              <thead>
                <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Title</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Status</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Play</th>
                  <th style={{ padding: "8px 6px", fontWeight: 600 }}>Download</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const src = row.mp3Url || row.wavUrl;
                  return (
                    <tr key={row.id} style={{ borderTop: "1px solid #1e293b" }}>
                      <td style={{ padding: "10px 6px" }}>{row.title}</td>
                      <td style={{ padding: "10px 6px", color: row.status === "Ready" ? "#86efac" : "#fca5a5" }}>{row.status}</td>
                      <td style={{ padding: "10px 6px" }}>
                        <button
                          type="button"
                          disabled={!src}
                          onClick={() => toggleRowAudio(row)}
                          style={{
                            backgroundColor: "#1e293b",
                            color: "#f8fafc",
                            border: "1px solid #1e293b",
                            borderRadius: 6,
                            padding: "6px 10px",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: src ? "pointer" : "not-allowed",
                          }}
                        >
                          {playingId === row.id ? "Pause" : "Play"}
                        </button>
                        {src ? (
                          <audio
                            ref={(node) => {
                              rowAudio.current[row.id] = node;
                            }}
                            src={src}
                            preload="none"
                            onEnded={() => setPlayingId((current) => (current === row.id ? null : current))}
                          />
                        ) : null}
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <div style={{ display: "flex", gap: 8 }}>
                          {row.mp3Url ? (
                            <button
                              type="button"
                              onClick={() => void triggerDownload(row.mp3Url, `${row.title}.mp3`)}
                              style={{ backgroundColor: "#1e293b", color: "#f8fafc", border: "1px solid #475569", borderRadius: 6, padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            >
                              MP3
                            </button>
                          ) : null}
                          {row.wavUrl ? (
                            <button
                              type="button"
                              onClick={() => void triggerDownload(row.wavUrl, `${row.title}.wav`)}
                              style={{ backgroundColor: "#1e293b", color: "#f8fafc", border: "1px solid #475569", borderRadius: 6, padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            >
                              WAV
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <TemplatesModal isOpen={isTemplatesOpen} onClose={() => setIsTemplatesOpen(false)} onSelectTemplate={handleApplyTemplate} />
        <ReferenceModal isOpen={isReferenceOpen} onClose={() => setIsReferenceOpen(false)} onReferenceSelected={() => undefined} />
      </div>
    </main>
  );
}
