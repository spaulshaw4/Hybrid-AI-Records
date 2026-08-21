import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

import { initBrowserSentry } from "./lib/sentry-browser";

// Client entry only — never imported from SSR modules. A `*.client.*` import
// from `__root` / `index` is denied by TanStack Start import-protection and
// was grouping as Sentry JAVASCRIPT-NEXTJS-1 (GET / 500).
initBrowserSentry();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
