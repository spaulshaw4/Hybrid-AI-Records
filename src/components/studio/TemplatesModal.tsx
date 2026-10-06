import { useState } from "react";
import { MUREKA_CATEGORIES, MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";
interface TemplatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: TrackTemplate) => void;
}
export default function TemplatesModal({ isOpen, onClose, onSelectTemplate }: TemplatesModalProps) {
  const [activeCategory, setActiveCategory] = useState("All");
  if (!isOpen) return null;
  const filtered = activeCategory === "All"
    ? MUREKA_TEMPLATES
    : MUREKA_TEMPLATES.filter((t) => t.category === activeCategory);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(5, 2, 5, 0.92)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        style={{
          backgroundColor: "#120a10",
          border: "1px solid rgba(244, 63, 94, 0.25)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 880,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.8)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "18px 24px 14px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>
              Templates
            </h3>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              Showing {filtered.length} production presets
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: 22,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {/* Category Pills Bar */}
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "12px 24px",
            overflowX: "auto",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          {MUREKA_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                backgroundColor: activeCategory === cat ? "#e11d48" : "rgba(255, 255, 255, 0.06)",
                color: activeCategory === cat ? "#ffffff" : "#94a3b8",
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background 0.15s",
              }}
            >
              {cat}
            </button>
          ))}
        </div>
        {/* Card Grid */}
        <div
          style={{
            padding: "20px 24px",
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 14,
          }}
        >
          {filtered.map((tmpl) => (
            <div
              key={tmpl.id}
              style={{
                backgroundColor: "rgba(25, 14, 22, 0.85)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: 10,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    color: "#f43f5e",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  {tmpl.category}
                </span>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#f8fafc", margin: "4px 0 6px" }}>
                  {tmpl.title}
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.4, marginBottom: 14 }}>
                  {tmpl.subtitle}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelectTemplate(tmpl);
                  onClose();
                }}
                style={{
                  width: "100%",
                  padding: "9px 0",
                  background: "linear-gradient(90deg, #e11d48 0%, #be123c 100%)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Use template
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { TemplatesModal };
