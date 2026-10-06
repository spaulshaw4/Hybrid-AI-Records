import { useState, type CSSProperties, type FormEvent } from "react";

import { type TrackTemplate } from "@/data/murekaTemplates";
import { ReferenceModal } from "@/components/studio/ReferenceModal";
import { TemplatesModal } from "@/components/studio/TemplatesModal";

export type GeneratePayload = {
  title: string;
  prompt: string;
  lyrics: string;
  gender: "male" | "female";
  isInstrumental: boolean;
  vocalId: string | null;
  referenceId: string | null;
};

type EnrolledVoice = { id: string; name: string };

type Props = {
  onGenerate: (payload: GeneratePayload) => Promise<void>;
  isLoading: boolean;
  enrolledVoice?: EnrolledVoice | null;
};

const pillStyle = (selected: boolean): CSSProperties => ({
  flex: 1,
  padding: "10px 0",
  borderRadius: 999,
  border: selected ? "1px solid #2563eb" : "1px solid #cbd5e1",
  background: selected ? "#2563eb" : "#ffffff",
  color: selected ? "#ffffff" : "#0f172a",
  fontWeight: 700,
  cursor: "pointer",
});

export function MurekaStudioForm({ onGenerate, isLoading, enrolledVoice = null }: Props) {
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [title, setTitle] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [activeVoice, setActiveVoice] = useState<EnrolledVoice | null>(enrolledVoice);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isReferenceOpen, setIsReferenceOpen] = useState(false);
  const [reference, setReference] = useState<{ id: string; name: string } | null>(null);

  function handleApplyTemplate(template: TrackTemplate) {
    setPrompt(template.prompt);
    setGender(template.recommendedGender);
    setIsInstrumental(template.isInstrumentalDefault);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isLoading || !prompt.trim()) return;
    await onGenerate({
      title: title.trim() || "Untitled Master",
      prompt,
      lyrics: isInstrumental ? "" : lyrics,
      gender,
      isInstrumental,
      vocalId: activeVoice ? activeVoice.id : null,
      referenceId: reference ? reference.id : null,
    });
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8 }} role="tablist" aria-label="Studio mode">
        {(["Easy", "Custom", "Soundtrack"] as const).map((tab) => {
          const selected = tab === "Custom";
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                background: selected ? "#0f172a" : "#f8fafc",
                color: selected ? "#ffffff" : "#64748b",
                fontWeight: 700,
                cursor: "default",
              }}
            >
              {tab}
            </button>
          );
        })}
      </div>

      <label style={{ fontSize: 13, fontWeight: 700 }}>
        Title
        <input
          value={title}
          maxLength={50}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Track title"
          style={{ display: "block", width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
        />
        <span style={{ display: "block", textAlign: "right", fontSize: 12, color: "#64748b" }}>{title.length}/50</span>
      </label>

      <label style={{ fontSize: 13, fontWeight: 700 }}>
        Prompt
        <textarea
          aria-label="Prompt"
          value={prompt}
          maxLength={1000}
          rows={5}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the record: instruments, tempo, vocal texture"
          style={{ display: "block", width: "100%", marginTop: 6, padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", resize: "vertical" }}
        />
        <span style={{ display: "block", textAlign: "right", fontSize: 12, color: "#64748b" }}>{prompt.length}/1000</span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setIsTemplatesOpen(true)} style={{ cursor: "pointer", fontWeight: 700 }}>
          📋 Templates
        </button>
        <button type="button" onClick={() => setIsReferenceOpen(true)} style={{ cursor: "pointer", fontWeight: 700 }}>
          Reference
        </button>
        <button type="button" style={{ cursor: "pointer", fontWeight: 700 }}>
          ✨ Enhance
        </button>
      </div>
      {reference ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span>Reference: {reference.name}</span>
          <button type="button" onClick={() => setReference(null)} aria-label="Clear reference">
            Clear
          </button>
        </div>
      ) : null}

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={isInstrumental}
          onChange={(event) => setIsInstrumental(event.target.checked)}
        />
        Instrumental
      </label>

      <label style={{ fontSize: 13, fontWeight: 700, color: isInstrumental ? "#94a3b8" : "#0f172a" }}>
        Lyrics
        <textarea
          aria-label="Lyrics"
          value={lyrics}
          rows={8}
          disabled={isInstrumental}
          onChange={(event) => setLyrics(event.target.value)}
          placeholder="Lyrics"
          style={{
            display: "block",
            width: "100%",
            marginTop: 6,
            padding: 10,
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            background: isInstrumental ? "#e2e8f0" : "#ffffff",
            color: isInstrumental ? "#94a3b8" : "#0f172a",
            resize: "vertical",
          }}
        />
      </label>

      {activeVoice ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #cbd5e1", borderRadius: 10, padding: 12 }}>
          <div>
            <p style={{ margin: 0, fontWeight: 700 }}>{activeVoice.name}</p>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>{activeVoice.id}</p>
          </div>
          <button type="button" aria-label="Clear enrolled voice" onClick={() => setActiveVoice(null)} style={{ cursor: "pointer" }}>
            ✕
          </button>
        </div>
      ) : (
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>Vocal Gender</p>
          <div style={{ display: "flex", gap: 8 }}>
            {(["female", "male"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={gender === value}
                onClick={() => setGender(value)}
                style={pillStyle(gender === value)}
              >
                {value === "female" ? "Female" : "Male"}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading || !prompt.trim()}
        style={{
          padding: "14px 0",
          border: "none",
          borderRadius: 8,
          background: isLoading || !prompt.trim() ? "#94a3b8" : "#111827",
          color: "#ffffff",
          fontWeight: 800,
          cursor: isLoading || !prompt.trim() ? "not-allowed" : "pointer",
        }}
      >
        {isLoading ? "Rendering & Vaulting Master..." : "🎵 Create"}
      </button>

      <TemplatesModal
        isOpen={isTemplatesOpen}
        onClose={() => setIsTemplatesOpen(false)}
        onSelectTemplate={handleApplyTemplate}
      />
      <ReferenceModal
        isOpen={isReferenceOpen}
        onClose={() => setIsReferenceOpen(false)}
        onReferenceSelected={(next) => setReference(next)}
      />
    </form>
  );
}
