import { useState } from "react";
import { createPortal } from "react-dom";

import { MUREKA_CATEGORIES, MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";

interface TemplatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: TrackTemplate) => void;
}

export default function TemplatesModal({ isOpen, onClose, onSelectTemplate }: TemplatesModalProps) {
  const [activeCategory, setActiveCategory] = useState("All");
  if (!isOpen || typeof document === "undefined") return null;
  const filtered =
    activeCategory === "All" ? MUREKA_TEMPLATES : MUREKA_TEMPLATES.filter((template) => template.category === activeCategory);

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Templates"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-rose-500/25 bg-[#120a10] text-white shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
          <div>
            <h3 className="m-0 text-lg font-bold text-slate-50">Templates</h3>
            <span className="text-xs text-slate-400">Showing {filtered.length} production presets</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="border-0 bg-transparent text-xl leading-none text-slate-400"
          >
            ✕
          </button>
        </div>
        <div className="mt-4 flex shrink-0 gap-2 overflow-x-auto px-6 py-2" role="group" aria-label="Genres">
          {MUREKA_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={activeCategory === category}
              onClick={() => setActiveCategory(category)}
              className={
                activeCategory === category
                  ? "whitespace-nowrap rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white"
                  : "whitespace-nowrap rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-slate-400"
              }
            >
              {category}
            </button>
          ))}
        </div>
        <div className="mt-4 max-h-[80vh] min-h-0 flex-1 overflow-y-auto px-6 pb-6" aria-label="Production presets">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5">
            {filtered.map((template) => (
              <div
                key={template.id}
                className="flex flex-col justify-between rounded-xl border border-white/10 bg-[rgba(25,14,22,0.85)] p-4"
              >
                <div>
                  <span className="text-[10px] font-extrabold uppercase tracking-wide text-rose-500">{template.category}</span>
                  <div className="mb-1.5 mt-1 text-sm font-bold text-slate-50">{template.title}</div>
                  <div className="mb-3.5 text-xs leading-snug text-slate-400">{template.subtitle}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onSelectTemplate(template);
                    onClose();
                  }}
                  className="w-full rounded-md border-0 bg-gradient-to-r from-rose-600 to-rose-800 py-2 text-xs font-bold text-white"
                >
                  Use template
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export { TemplatesModal };
