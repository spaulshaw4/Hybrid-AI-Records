import { useEffect, useState } from "react";
import { RotateCcw, Settings } from "lucide-react";
import { toast } from "sonner";
import { resetCurrency } from "@/lib/currency";
import { DEFAULT_LANGUAGE, setLanguage } from "@/lib/i18n";
import { resetDivisionNames } from "@/lib/division-settings";
import { settingsErrorMessage } from "@/lib/settings-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { GlowIntensityControl } from "@/components/GlowIntensityControl";
import { GlowStrengthControl } from "@/components/GlowStrengthControl";
import { resetGlowStrength } from "@/lib/glow-strength";
import { resetGlowIntensity } from "@/lib/glow-intensity";

/**
 * Single gear entry point for secondary site controls, so the header stays
 * down to brand, links and the primary CTA.
 *
 * Built on the Radix dialog primitive so focus is trapped inside the panel,
 * ESC and overlay clicks close it, focus returns to the gear on close, and the
 * dialog is announced with its title and description.
 */
export function SettingsMenu() {

  const [open, setOpen] = useState(false);

  // Press "S" anywhere (outside a text field) to open Settings.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "s" && event.key !== "S") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      // Don't steal the key from another open dialog / menu.
      if (document.querySelector("[role='dialog'],[role='menu'],[role='listbox']")) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);


  const labelClass =
    "mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label="Site settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "site-settings-dialog" : undefined}
        title="Site settings — text glow and divisions (shortcut: S)"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/60 bg-white/70 text-foreground/80 backdrop-blur-sm transition-colors hover:border-primary hover:bg-primary/10 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] [&_svg]:pointer-events-none"
      >
        <Settings size={18} aria-hidden="true" />
      </DialogTrigger>


      <DialogContent
        id="site-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-settings-title"
        aria-describedby="site-settings-description"
        className="sm:max-w-md studio-glass sm:rounded-xl"
      >
        <DialogHeader className="mb-2">
          <DialogTitle
            id="site-settings-title"
            className="font-display text-xl font-semibold text-white"
          >
            Site settings
          </DialogTitle>
          <DialogDescription
            id="site-settings-description"
            className="text-sm text-muted-foreground"
          >
            Text glow and division display options. Currency and language stay in the header.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section aria-labelledby="settings-glow">
            <h2 id="settings-glow" className={labelClass}>
              Text glow
            </h2>
            <div className="mt-2">
              <GlowIntensityControl />
            </div>
            <div className="mt-4">
              <GlowStrengthControl />
            </div>
          </section>

          <section aria-labelledby="settings-reset" className="border-t border-border-strong pt-5">
            <h2 id="settings-reset" className={labelClass}>
              Reset
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Restores US Dollar (USD), English (EN), the default text glow and the original division names.
            </p>
            <button
              type="button"
              onClick={() => {
                try {
                  resetCurrency();
                  setLanguage(DEFAULT_LANGUAGE);
                  resetDivisionNames();
                  resetGlowStrength();
                  resetGlowIntensity();
                  toast.success("Settings reset to defaults", {
                    description: "US Dollar (USD) · English (EN) · default text glow · original division names",
                  });
                } catch (error) {
                  toast.error("Couldn't reset settings", {
                    description: settingsErrorMessage(error),
                  });
                }
              }}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-border-strong px-4 py-2 text-sm font-semibold uppercase tracking-widest text-white transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              <RotateCcw size={15} aria-hidden="true" />
              Reset to defaults
            </button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
