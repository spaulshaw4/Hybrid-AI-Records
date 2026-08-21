import { useEffect, useState } from "react";
import { Download, Share } from "lucide-react";
import { toast } from "sonner";
import { IosInstallHelpModal } from "./IosInstallHelpModal";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * "Install App" button.
 *
 * On Android/Chrome we capture `beforeinstallprompt` and trigger the real
 * WebAPK install — that path uses the maskable icon, so the crest lands
 * full-bleed on black instead of the white shortcut badge the launcher draws
 * for plain home-screen bookmarks. iOS has no install API, so we explain the
 * Share > Add to Home Screen route instead.
 */
export function InstallAppButton({ className = "" }: { className?: string }) {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [platform, setPlatform] = useState<"ios-safari" | "ios-other" | "samsung" | "other">(
    "other",
  );
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    const ua = window.navigator.userAgent;
    // iPadOS 13+ reports as a Mac, so touch points disambiguate the tablet.
    const isIos =
      /iphone|ipad|ipod/i.test(ua) ||
      (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
    // Only Safari can add to the home screen on iOS — Chrome/Firefox/in-app
    // browsers (Instagram, Facebook) have no Share > Add to Home Screen item.
    const isIosSafari = isIos && !/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line/i.test(ua);
    setPlatform(
      isIos
        ? isIosSafari
          ? "ios-safari"
          : "ios-other"
        : /SamsungBrowser/i.test(ua)
          ? "samsung"
          : "other",
    );

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const androidInstructions =
    platform === "samsung"
      ? "Delete the current Hybrid AI icon. In Samsung Internet tap ☰ (bottom right) → “Add page to” → “Home screen”, then confirm “Install”. If One UI still draws a white ring, open Settings → Home screen → Icon frames → “Icons only”."
      : "Delete the current Hybrid AI icon first. Then in Chrome tap ⋮ → “Add to Home screen” and pick “Install” (not “Create shortcut”) — the shortcut option is what draws the white circle.";

  const handleClick = async () => {
    if (platform === "ios-safari" || platform === "ios-other") {
      setShowIosSheet(true);
      return;
    }

    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      setDeferred(null);
      if (outcome === "accepted") {
        toast.success("Installing Hybrid AI Records", {
          description: "The app icon will appear on your home screen.",
        });
      }
      return;
    }

    toast("Install as an app (not a shortcut)", {
      description: androidInstructions,
      duration: 12000,
    });
  };

  return (
    <>
      <button type="button" onClick={handleClick} className={`btn-ghost ${className}`}>
        <Download size={16} aria-hidden="true" /> Install App
      </button>

      {showIosSheet ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install Hybrid AI Records on iPhone or iPad"
          className="fixed inset-0 z-[120] flex items-end justify-center overlay-scrim bg-foreground/40 p-4 backdrop-blur-sm sm:items-center"
          onClick={() => setShowIosSheet(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-foreground">Add to your Home Screen</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {platform === "ios-other"
                ? "iPhone and iPad only allow this from Safari. Open hybrid-ai-records.com in Safari, then:"
                : "Apple doesn’t allow one-tap installs — these three taps do the same thing:"}
            </p>
            <ol className="mt-3 space-y-2 text-sm text-foreground">
              <li className="flex gap-2">
                <span className="text-primary">1.</span>
                <span>
                  Tap the <Share size={14} className="inline align-[-2px]" aria-hidden="true" />{" "}
                  <strong>Share</strong> button in Safari’s toolbar.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary">2.</span>
                <span>
                  Scroll down and choose <strong>Add to Home Screen</strong>.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary">3.</span>
                <span>
                  Tap <strong>Add</strong> — the eagle crest lands on your home screen and opens
                  full-screen, no browser bar.
                </span>
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIosHelp(true)}
              className="mt-4 text-sm text-primary underline underline-offset-4"
            >
              I don’t see “Add to Home Screen”
            </button>
            <button
              type="button"
              onClick={() => setShowIosSheet(false)}
              className="btn-primary mt-4 w-full justify-center"
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}

      {showIosHelp ? (
        <IosInstallHelpModal
          browser={platform === "ios-other" ? "other" : "safari"}
          onClose={() => setShowIosHelp(false)}
        />
      ) : null}
    </>
  );
}
