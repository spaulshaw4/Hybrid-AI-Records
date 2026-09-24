import { createFileRoute } from "@tanstack/react-router";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ASSETS_ROOT = join("C:", "live_web_outputs", "releases", "assets");
const SESSION_RE = /^(ht_[a-f0-9]{8,})_master\.(wav|mp3)$/i;

/** GET /api/local-releases — session ids published under live_web_outputs assets. */
export const Route = createFileRoute("/api/local-releases")({
  server: {
    handlers: {
      GET: handleList,
    },
  },
});

async function handleList(): Promise<Response> {
  try {
    const names = await readdir(ASSETS_ROOT);
    const ids = new Set<string>();
    for (const name of names) {
      const match = name.match(SESSION_RE);
      if (match?.[1]) ids.add(match[1]);
    }
    return Response.json({ sessions: [...ids] });
  } catch {
    return Response.json({ sessions: [] });
  }
}
