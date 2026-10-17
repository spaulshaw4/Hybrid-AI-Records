import { createFileRoute } from "@tanstack/react-router";
import { renderCatalogMrss } from "@/lib/mrss-feed.server";

export const Route = createFileRoute("/api/feed/mrss.xml")({
  server: {
    handlers: {
      GET: async () => {
        const xml = await renderCatalogMrss();
        return new Response(xml, {
          status: 200,
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
