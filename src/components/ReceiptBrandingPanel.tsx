import { useRef, useState } from "react";
import { Palette, RotateCcw, Upload, X } from "lucide-react";
import {
  ACCENT_PRESETS,
  DEFAULT_BRANDING,
  LAYOUT_OPTIONS,
  fileToDataUrl,
  loadDefaultLogo,
  resetBranding,
  saveBranding,
  type ReceiptBranding,
} from "@/lib/receipt-branding";

type Props = {
  branding: ReceiptBranding;
  onChange: (next: ReceiptBranding) => void;
};

const inputClass =
  "w-full border border-border-strong bg-ink/50 px-3 py-2 text-xs text-white outline-none transition-colors placeholder:text-muted-foreground focus:border-primary";
const labelClass =
  "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground";

/** Lets the artist tune logo, colors and layout of the receipt PDF before downloading. */
export function ReceiptBrandingPanel({ branding, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<ReceiptBranding>) => {
    const next = { ...branding, ...patch };
    onChange(next);
    saveBranding(next);
  };

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setBusy("Use a PNG or JPEG logo.");
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      setBusy("Logo must be under 1.5 MB.");
      return;
    }
    try {
      setBusy("Reading logo…");
      update({ logoDataUrl: await fileToDataUrl(file) });
      setBusy("Logo applied.");
    } catch {
      setBusy("Could not read that image.");
    }
  };

  const useLabelLogo = async () => {
    try {
      setBusy("Loading label logo…");
      update({ logoDataUrl: await loadDefaultLogo() });
      setBusy("Label logo applied.");
    } catch {
      setBusy("Could not load the label logo.");
    }
  };

  return (
    <div className="mt-4 border border-border-strong bg-ink/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start transition-colors hover:bg-white/5"
      >
        <span className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white">
          <Palette size={13} aria-hidden="true" className="text-primary" />
          Customize receipt branding
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {open ? "Hide" : "Logo · colors · layout"}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border-strong px-3 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="brand-name">
                Label name
              </label>
              <input
                id="brand-name"
                className={inputClass}
                value={branding.labelName}
                onChange={(e) => update({ labelName: e.target.value })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="brand-tagline">
                Document subtitle
              </label>
              <input
                id="brand-tagline"
                className={inputClass}
                value={branding.tagline}
                onChange={(e) => update({ tagline: e.target.value })}
              />
            </div>
          </div>

          <div>
            <span className={labelClass}>Logo</span>
            <div className="flex flex-wrap items-center gap-3">
              {branding.logoDataUrl ? (
                <img
                  src={branding.logoDataUrl}
                  alt="Receipt logo preview"
                  className="h-12 w-12 border border-border-strong bg-white/5 object-contain"
                />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center border border-dashed border-border-strong font-mono text-[9px] uppercase text-muted-foreground">
                  None
                </span>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                onChange={(e) => void pickLogo(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1.5 border border-border-strong px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
              >
                <Upload size={12} aria-hidden="true" />
                Upload
              </button>
              <button
                type="button"
                onClick={() => void useLabelLogo()}
                className="border border-border-strong px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
              >
                Use label logo
              </button>
              {branding.logoDataUrl && (
                <button
                  type="button"
                  onClick={() => update({ logoDataUrl: null })}
                  className="inline-flex items-center gap-1.5 border border-border-strong px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
                >
                  <X size={12} aria-hidden="true" />
                  Remove
                </button>
              )}
            </div>
          </div>

          <div>
            <span className={labelClass}>Color scheme</span>
            <div className="flex flex-wrap gap-2">
              {ACCENT_PRESETS.map((p) => {
                const active = p.accent.toLowerCase() === branding.accent.toLowerCase();
                return (
                  <button
                    key={p.accent}
                    type="button"
                    onClick={() => update({ accent: p.accent, ink: p.ink })}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                      active
                        ? "border-primary text-white"
                        : "border-border-strong text-muted-foreground hover:border-primary hover:text-white"
                    }`}
                  >
                    <span
                      className="h-3 w-3 border border-white/20"
                      style={{ backgroundColor: p.accent }}
                      aria-hidden="true"
                    />
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Accent
                <input
                  type="color"
                  value={branding.accent}
                  onChange={(e) => update({ accent: e.target.value })}
                  className="h-7 w-10 cursor-pointer border border-border-strong bg-transparent"
                  aria-label="Accent color"
                />
              </label>
              <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Header / text
                <input
                  type="color"
                  value={branding.ink}
                  onChange={(e) => update({ ink: e.target.value })}
                  className="h-7 w-10 cursor-pointer border border-border-strong bg-transparent"
                  aria-label="Header color"
                />
              </label>
            </div>
          </div>

          <div>
            <span className={labelClass}>Layout</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {LAYOUT_OPTIONS.map((opt) => {
                const active = branding.layout === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update({ layout: opt.value })}
                    aria-pressed={active}
                    className={`border px-3 py-2 text-start transition-colors ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border-strong hover:border-primary"
                    }`}
                  >
                    <span className="block font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white">
                      {opt.label}
                    </span>
                    <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                      {opt.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="brand-footer">
              Footer note
            </label>
            <textarea
              id="brand-footer"
              rows={2}
              className={inputClass}
              value={branding.footerNote}
              onChange={(e) => update({ footerNote: e.target.value })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                resetBranding();
                onChange(DEFAULT_BRANDING);
                setBusy("Branding reset to label defaults.");
              }}
              className="inline-flex items-center gap-1.5 border border-border-strong px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Reset
            </button>
            <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
              {busy ?? "Changes apply to the preview and every download."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReceiptBrandingPanel;
