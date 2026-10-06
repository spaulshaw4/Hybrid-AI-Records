import { useState } from "react";

import { MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";

interface TemplatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: TrackTemplate) => void;
}

const CATEGORIES = ["All", "Trending", "Rock", "Hip-hop", "Electronic", "R&B", "Pop", "Latin"];

export default function TemplatesModal({ isOpen, onClose, onSelectTemplate }: TemplatesModalProps) {
  const [activeCategory, setActiveCategory] = useState("All");
  if (!isOpen) return null;

  const filtered =
    activeCategory === "All"
      ? MUREKA_TEMPLATES
      : MUREKA_TEMPLATES.filter((template) => template.category === activeCategory);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Style Templates"
        style={{
          backgroundColor: "#0d1117",
          border: "1px solid #1e293b",
          borderRadius: 12,
          width: "100%",
          maxWidth: 860,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #1e293b",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f8fafc" }}>Style Templates</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close templates"
            style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 20, cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "12px 20px",
            overflowX: "auto",
            borderBottom: "1px solid #1e293b",
          }}
        >
          {CATEGORIES.map((cat) => (
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
                backgroundColor: activeCategory === cat ? "#0284c7" : "#1e293b",
                color: activeCategory === cat ? "#ffffff" : "#94a3b8",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {cat}
            </button>
          ))}
        </div>
        <div
          style={{
            padding: 20,
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
                backgroundColor: "#161f30",
                border: "1px solid #243248",
                borderRadius: 8,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#f8fafc", marginBottom: 6 }}>{tmpl.title}</div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.4, marginBottom: 16 }}>{tmpl.subtitle}</div>
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
                  background: "linear-gradient(90deg, #0284c7, #2563eb)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
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
