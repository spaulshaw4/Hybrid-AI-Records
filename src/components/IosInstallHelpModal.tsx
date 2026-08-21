import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { IosInstallDiagnostics } from "./IosInstallDiagnostics";

/**
 * Troubleshooting sheet for "I don't see Add to Home Screen".
 *
 * The body is the self-diagnosing widget: it detects Safari vs non-Safari
 * (including in-app webviews), Private Browsing, secure context and installed
 * state, then shows only the steps that apply.
 */
export function IosInstallHelpModal({ onClose }: { browser?: "safari" | "other"; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ios-help-title"
      className="fixed inset-0 z-[130] flex items-end justify-center overlay-scrim bg-foreground/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-2xl border border-border bg-card p-5 text-left shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="ios-help-title" className="text-base font-semibold text-foreground">
            “Add to Home Screen” isn’t showing
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close troubleshooting"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <IosInstallDiagnostics className="mt-4" />


        <button type="button" onClick={onClose} className="btn-primary mt-5 w-full justify-center">
          Got it
        </button>
      </div>
    </div>
  );
}
