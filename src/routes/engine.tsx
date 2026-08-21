import { createFileRoute } from "@tanstack/react-router";

import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { AudioStudio } from "@/components/AudioStudio";
import { Badge } from "@/components/ui/badge";
import { LABEL_ID, SITE_URL, buildPageJsonLd } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


export const Route = createFileRoute("/engine")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: "Hybrid Engine 1.0 — AI Music Generator" },
      {
        name: "description",
        content:
          "Generate release-ready AI music with Hybrid Engine 1.0. Write lyrics, pick a style, set vocals, and download a mastered track in minutes — one Hybrid Token per generation.",
      },
      { property: "og:title", content: "Hybrid Engine 1.0 — AI Music Generator" },
      {
        property: "og:description",
        content:
          "Generate release-ready AI music with Hybrid Engine 1.0. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://hybrid-ai-records.com/engine" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Hybrid Engine 1.0 — AI Music Generator" },
      {
        name: "twitter:description",
        content:
          "Generate release-ready AI music with Hybrid Engine 1.0. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
      },
    ],
    links: [
      { rel: "canonical", href: "https://hybrid-ai-records.com/engine" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/engine",
            name: "Hybrid Engine 1.0 — AI Music Generator",
            description:
              "Generate release-ready AI music with Hybrid Engine 1.0. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
            breadcrumb: [{ name: "Hybrid Engine 1.0", path: "/engine" }],
            extra: [
              {
                "@type": ["WebApplication", "SoftwareApplication"],
                "@id": `${SITE_URL}/engine#app`,
                name: "Hybrid Engine 1.0",
                applicationCategory: "MusicApplication",
                operatingSystem: "Any",
                softwareVersion: "1.0",
                description:
                  "AI music generation engine for independent artists. Write lyrics, pick a style, set vocals, and download a mastered track.",
                url: `${SITE_URL}/engine`,
                provider: { "@id": LABEL_ID },
                publisher: { "@id": LABEL_ID },
                offers: {
                  "@type": "Offer",
                  price: "2.50",
                  priceCurrency: "USD",
                  description: "One Hybrid Token — one generated and mastered track.",
                  url: `${SITE_URL}/tokens`,
                },
              },
            ],
          }),
        ),
      },
    ],

  }),
  component: EnginePage,
});

function EnginePage() {
  return (
    <main
      id="engine-workspace"
      className="relative z-10 min-h-[calc(100dvh-var(--site-header-height)-var(--site-dock-height))] bg-transparent py-6 sm:py-8"
    >
      <div className="mx-auto mb-6 w-full max-w-3xl px-4">
        <PortalBreadcrumb trail={[{ label: "Hybrid Engine 1.0" }]} />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Hybrid Engine 1.0</h1>
          <Badge
            variant="outline"
            className="border-status-outline text-status-accent bg-transparent font-mono text-xs tracking-wider"
          >
            v1.0
          </Badge>
        </div>
        <p className="mt-2 text-muted-foreground">
          Raw words. Real music. One prompt, one token, one mastered track.
        </p>
      </div>

      <section className="w-full px-4">
        <AudioStudio />
      </section>
    </main>
  );
}
