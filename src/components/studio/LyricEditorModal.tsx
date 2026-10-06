import { useEffect, useState, type CSSProperties } from "react";

interface LyricEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTitle: string;
  currentPrompt: string;
  initialLyrics: string;
  onApplyLyrics: (lyrics: string) => void;
}

const toolButtonStyle: CSSProperties = {
  background: "#1f293d",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  color: "#e2e8f0",
  borderRadius: 6,
  padding: "7px 14px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

export default function LyricEditorModal({
  isOpen,
  onClose,
  currentTitle,
  currentPrompt,
  initialLyrics,
  onApplyLyrics,
}: LyricEditorModalProps) {
  const [draftLyrics, setDraftLyrics] = useState(initialLyrics);
  const [topic, setTopic] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingLyrics, setIsGeneratingLyrics] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDraftLyrics(initialLyrics);
  }, [isOpen, initialLyrics]);

  if (!isOpen) return null;

  const handleAction = async (action: "optimize" | "section" | "next_line" | "generate_topic") => {
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          lyrics: draftLyrics,
          title: currentTitle,
          prompt: currentPrompt,
          topic,
        }),
      });
      const data = (await res.json()) as { success?: boolean; result?: string; lyrics?: string; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || "Action failed");
      const result = data.lyrics || data.result || "";
      if (action === "next_line") {
        setDraftLyrics((prev) => `${prev.trim()}\n${result}`);
      } else {
        setDraftLyrics(result);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setStatusMessage(message || "Failed to process lyric task.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateLyricsClick = async () => {
    setIsGeneratingLyrics(true);
    setStatusMessage(null);
    try {
      const effectiveTopic = topic.trim() || draftLyrics.trim() || "the moon in my eyes color the night";
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_lyrics",
          topic: effectiveTopic,
          lyrics: draftLyrics,
          title: currentTitle.trim() || "Untitled Track",
        }),
      });
      const data = (await res.json()) as { lyrics?: string; result?: string; error?: string };
      if (!res.ok) {
        setStatusMessage(data.error || "Could not generate lyrics.");
        return;
      }
      const generated = data.lyrics || data.result || "";
      if (generated) {
        setDraftLyrics(generated);
        setTopic("");
      }
    } catch {
      setStatusMessage("Network connection error.");
    } finally {
      setIsGeneratingLyrics(false);
    }
  };

  const toolsDisabled = isLoading || isGeneratingLyrics || !draftLyrics.trim();

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lyric workshop"
        style={{
          background: "#161b26",
          backgroundColor: "#161b26",
          color: "#f8fafc",
          colorScheme: "dark",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 680,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "18px 24px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>
            {currentTitle.trim() || "Untitled Track"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close lyric workshop"
            style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 20, cursor: "pointer" }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "20px 24px 10px" }}>
          <textarea
            aria-label="Draft lyrics"
            value={draftLyrics}
            onChange={(event) => setDraftLyrics(event.target.value)}
            placeholder="Type, paste, or generate your song lyrics..."
            maxLength={5000}
            rows={10}
            style={{
              width: "100%",
              background: "rgba(10, 14, 23, 0.7)",
              backgroundColor: "rgba(10, 14, 23, 0.7)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: 8,
              padding: 14,
              color: "#f8fafc",
              colorScheme: "dark",
              fontSize: 14,
              lineHeight: 1.6,
              outline: "none",
              resize: "vertical",
              fontFamily: "monospace",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" disabled={toolsDisabled} onClick={() => void handleAction("optimize")} style={toolButtonStyle}>
                ≡ Lyric optimize
              </button>
              <button type="button" disabled={toolsDisabled} onClick={() => void handleAction("section")} style={toolButtonStyle}>
                ⤺ Section
              </button>
              <button type="button" disabled={toolsDisabled} onClick={() => void handleAction("next_line")} style={toolButtonStyle}>
                ✎ Write next line
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontSize: 12, color: "#64748b" }}>{draftLyrics.length}/5000</span>
              <button
                type="button"
                onClick={() => {
                  onApplyLyrics(draftLyrics);
                  onClose();
                }}
                style={{
                  background: "#f8fafc",
                  backgroundColor: "#f8fafc",
                  color: "#0f172a",
                  border: "none",
                  borderRadius: 6,
                  padding: "7px 16px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ✓ Use this lyrics
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: "16px 24px 24px" }}>
          <div
            style={{
              backgroundColor: "rgba(10, 14, 23, 0.7)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: 8,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <input
              type="text"
              aria-label="Lyric theme or topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Explain the lyrics you're looking for, or give me a theme or topic."
              style={{
                flex: 1,
                background: "transparent",
                backgroundColor: "transparent",
                border: "none",
                outline: "none",
                color: "#f8fafc",
                colorScheme: "dark",
                fontSize: 13,
              }}
            />
            <button
              type="button"
              onClick={() => void handleGenerateLyricsClick()}
              disabled={isGeneratingLyrics || isLoading}
              style={{
                backgroundColor: "#0284c7",
                color: "#ffffff",
                border: "none",
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 12,
                fontWeight: 700,
                cursor: isGeneratingLyrics || isLoading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
              }}
            >
              {isGeneratingLyrics ? "Writing..." : "✨ Generate random lyrics"}
            </button>
          </div>
          {statusMessage ? <div style={{ marginTop: 8, fontSize: 12, color: "#f87171" }}>{statusMessage}</div> : null}
        </div>
      </div>
    </div>
  );
}
