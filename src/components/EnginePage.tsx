import { useState, type FormEvent } from "react";

import { ReferenceModal } from "@/components/studio/ReferenceModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { type TrackTemplate } from "@/data/murekaTemplates";

interface VaultedTrack {
  id: string;
  title: string;
  prompt: string;
  wavUrl: string;
  mp3Url: string;
}

const pillStyle = {
  background: "#121826",
  border: "1px solid #1e293b",
  borderRadius: 8,
  padding: "10px 0",
  color: "#cbd5e1",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
} as const;

export function EnginePage() {
  const [activeTab, setActiveTab] = useState<"custom" | "easy">("custom");
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isReferenceOpen, setIsReferenceOpen] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [completedTrack, setCompletedTrack] = useState<VaultedTrack | null>(null);

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

  const handleApplyTemplate = (tmpl: TrackTemplate) => {
    setPrompt(tmpl.prompt);
    setGender(tmpl.recommendedGender);
    setIsInstrumental(tmpl.isInstrumentalDefault);
  };

  const handleGenerate = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setErrorMessage(null);
    setCompletedTrack(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || "Untitled Master",
          prompt: prompt.trim(),
          lyrics: isInstrumental ? "" : lyrics.trim(),
          gender,
          isInstrumental,
          ...(referenceId ? { referenceId } : {}),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        taskId?: string;
        wavUrl?: string;
        mp3Url?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Generation rejected by upstream engine");
      }
      setCompletedTrack({
        id: data.taskId || Date.now().toString(),
        title: title.trim() || "Untitled Master",
        prompt: prompt.trim(),
        wavUrl: data.wavUrl ?? "",
        mp3Url: data.mp3Url ?? "",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "An unexpected error occurred during synthesis.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", backgroundColor: "#0b0f19", color: "#f8fafc", padding: "28px 16px 120px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div
          style={{ display: "flex", gap: 24, borderBottom: "1px solid #1e293b", paddingBottom: 10, marginBottom: 18 }}
          role="tablist"
          aria-label="Studio mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "easy"}
            onClick={() => setActiveTab("easy")}
            style={{
              background: "transparent",
              border: "none",
              color: activeTab === "easy" ? "#38bdf8" : "#94a3b8",
              fontWeight: 700,
              fontSize: 15,
              borderBottom: activeTab === "easy" ? "2px solid #38bdf8" : "2px solid transparent",
              paddingBottom: 6,
              cursor: "pointer",
            }}
          >
            Easy
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "custom"}
            onClick={() => setActiveTab("custom")}
            style={{
              background: "transparent",
              border: "none",
              color: activeTab === "custom" ? "#38bdf8" : "#94a3b8",
              fontWeight: 700,
              fontSize: 15,
              borderBottom: activeTab === "custom" ? "2px solid #38bdf8" : "2px solid transparent",
              paddingBottom: 6,
              cursor: "pointer",
            }}
          >
            Custom
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <button type="button" onClick={() => setIsReferenceOpen(true)} style={pillStyle}>
            + Reference
          </button>
          <button type="button" style={pillStyle}>
            + Remix
          </button>
          <button type="button" style={pillStyle}>
            + Vocal
          </button>
        </div>

        {errorMessage ? (
          <div
            style={{
              backgroundColor: "#7f1d1d",
              border: "1px solid #dc2626",
              color: "#fecaca",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            <strong>Upstream Notice:</strong> {errorMessage}
          </div>
        ) : null}

        <form onSubmit={(event) => void handleGenerate(event)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ backgroundColor: "#121826", border: "1px solid #1e293b", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#f8fafc" }}>
                {isInstrumental ? "Lyrics disabled" : "Lyrics"}
              </span>
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
                    background: "transparent",
                    border: "none",
                    color: "#f8fafc",
                    outline: "none",
                    resize: "none",
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 10,
                    borderTop: "1px solid #1e293b",
                    paddingTop: 10,
                    fontSize: 12,
                    color: "#64748b",
                  }}
                >
                  <div style={{ display: "flex", gap: 14 }}>
                    <span style={{ cursor: "pointer" }}>✨ Optimize</span>
                    <span style={{ cursor: "pointer" }}>📋 Generate Lyrics</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLyrics("")}
                    title="Clear lyrics"
                    aria-label="Clear lyrics"
                    style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                  >
                    🗑️
                  </button>
                </div>
              </>
            )}
          </div>

          <div style={{ backgroundColor: "#121826", border: "1px solid #1e293b", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#f8fafc" }}>Style</span>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  title="Bookmark prompt"
                  aria-label="Bookmark prompt"
                  style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                >
                  🔖
                </button>
                <button
                  type="button"
                  onClick={() => setPrompt("")}
                  title="Clear style"
                  aria-label="Clear style"
                  style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
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
                background: "transparent",
                border: "none",
                color: "#f8fafc",
                outline: "none",
                resize: "none",
                fontSize: 14,
                lineHeight: 1.5,
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: 10,
                borderTop: "1px solid #1e293b",
                paddingTop: 10,
                fontSize: 12,
                color: "#64748b",
              }}
            >
              <div style={{ display: "flex", gap: 14 }}>
                <span style={{ cursor: "pointer" }}>✨ Enhance</span>
                <button
                  type="button"
                  onClick={() => setIsTemplatesOpen(true)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#38bdf8",
                    cursor: "pointer",
                    padding: 0,
                    fontWeight: 600,
                  }}
                >
                  📋 Templates
                </button>
                <span style={{ cursor: "pointer" }}>🔖 My prompts</span>
              </div>
              <span>{prompt.length}/1000</span>
            </div>
          </div>

          {isInstrumental ? null : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: "#121826",
                border: "1px solid #1e293b",
                borderRadius: 10,
                padding: "10px 16px",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>Vocal Gender</span>
              <div
                style={{
                  display: "flex",
                  backgroundColor: "#0b0f19",
                  borderRadius: 6,
                  padding: 3,
                  border: "1px solid #1e293b",
                }}
              >
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

          <div
            style={{
              backgroundColor: "#121826",
              border: "1px solid #1e293b",
              borderRadius: 10,
              padding: "12px 16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <input
              type="text"
              aria-label="Song title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Enter song title"
              maxLength={50}
              style={{ background: "transparent", border: "none", color: "#f8fafc", outline: "none", fontSize: 14, width: "80%" }}
            />
            <span style={{ fontSize: 12, color: "#64748b" }}>{title.length}/50</span>
          </div>

          <button
            type="submit"
            disabled={isGenerating || !prompt.trim()}
            style={{
              padding: "14px 0",
              background: isGenerating ? "#1e293b" : "linear-gradient(90deg, #0284c7 0%, #06b6d4 100%)",
              color: "#ffffff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 700,
              cursor: isGenerating ? "not-allowed" : "pointer",
              boxShadow: "0 0 16px rgba(6, 182, 212, 0.25)",
            }}
          >
            {isGenerating ? "Synthesizing & Vaulting..." : "🎵 Create"}
          </button>
        </form>

        {completedTrack ? (
          <div
            style={{
              marginTop: 24,
              backgroundColor: "#121826",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 18,
            }}
          >
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{completedTrack.title}</h3>
              <span style={{ fontSize: 12, color: "#38bdf8", fontWeight: 600 }}>Permanent Audio Vault (Dual Delivery)</span>
            </div>
            <audio
              controls
              src={completedTrack.mp3Url || completedTrack.wavUrl}
              style={{ width: "100%", marginBottom: 14 }}
            />
            <div style={{ display: "grid", gridTemplateColumns: completedTrack.mp3Url ? "1fr 1fr" : "1fr", gap: 10 }}>
              <button
                type="button"
                onClick={() => {
                  if (!completedTrack.wavUrl) return;
                  void triggerDownload(completedTrack.wavUrl, `${completedTrack.title}.wav`);
                }}
                style={{
                  padding: "9px 0",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  color: "#f8fafc",
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ↓ Download WAV
              </button>
              {completedTrack.mp3Url ? (
                <button
                  type="button"
                  onClick={() => {
                    void triggerDownload(completedTrack.mp3Url, `${completedTrack.title}.mp3`);
                  }}
                  style={{
                    padding: "9px 0",
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    color: "#f8fafc",
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  ↓ Download MP3
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <TemplatesModal
          isOpen={isTemplatesOpen}
          onClose={() => setIsTemplatesOpen(false)}
          onSelectTemplate={handleApplyTemplate}
        />
        <ReferenceModal
          isOpen={isReferenceOpen}
          onClose={() => setIsReferenceOpen(false)}
          onReferenceSelected={(next) => setReferenceId(next.id)}
        />
      </div>
    </main>
  );
}
