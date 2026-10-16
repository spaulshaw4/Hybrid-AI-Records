import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

import { initBrowserSentry } from "./lib/sentry-browser";

// Client entry only — never imported from SSR modules. A `*.client.*` import
// from `__root` / `index` is denied by TanStack Start import-protection and
// was grouping as Sentry JAVASCRIPT-NEXTJS-1 (GET / 500).
initBrowserSentry();

// The homepage inline script can open a video dialog before this module
// evaluates. Detach it so hydrateRoot matches the server HTML. Home reads
// window.__previewVideoOpen and mounts the real dialog in a layout effect.
const prehydratedVideo = document.querySelector("[data-prehydrate-video]");
if (prehydratedVideo) {
  (window as Window & { __previewVideoOpen?: boolean }).__previewVideoOpen = true;
  prehydratedVideo.remove();
}

// Hydrate in the deferred entry module, before DOMContentLoaded. A transition
// deferred this until idle, so keyboard handlers were still missing after the
// poster and the order form were already on screen.
hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);
