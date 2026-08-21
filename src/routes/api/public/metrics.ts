import { createFileRoute } from "@tanstack/react-router";

/**
 * Prometheus scrape endpoint for the music engine.
 *
 * Requires `Authorization: Bearer $METRICS_TOKEN` (or `?token=`); returns 503
 * when no token is configured so metrics are never exposed anonymously.
 */
export const Route = createFileRoute("/api/public/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = process.env["METRICS_TOKEN"];
        if (!token) {
          return new Response("Metrics disabled: METRICS_TOKEN is not configured\n", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        const header = request.headers.get("authorization") ?? "";
        const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        const queryToken = new URL(request.url).searchParams.get("token") ?? "";
        const provided = bearer || queryToken;

        const encoder = new TextEncoder();
        const a = encoder.encode(provided);
        const b = encoder.encode(token);
        let equal = a.length === b.length;
        for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
          if ((a[i] ?? 0) !== (b[i] ?? 0)) equal = false;
        }
        if (!equal) {
          return new Response("Unauthorized\n", {
            status: 401,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        const [{ renderPrometheusMetrics, setGauge }, { musicEngineBreakerState }] =
          await Promise.all([
            import("@/lib/engine-metrics.server"),
            import("@/lib/apiframe.server"),
          ]);

        // Refresh breaker gauges so a scrape reflects live state, including cooldown expiry.
        for (const target of musicEngineBreakerState().targets) {
          setGauge("music_engine_breaker_open", target.open ? 1 : 0, { target: target.target });
          setGauge("music_engine_breaker_failures", target.failures, { target: target.target });
        }

        return new Response(renderPrometheusMetrics(), {
          status: 200,
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
