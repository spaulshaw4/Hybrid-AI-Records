import { createFileRoute } from "@tanstack/react-router";

import { EnginePage as EngineStudio } from "@/components/EnginePage";
import { StudioErrorBoundary } from "@/components/StudioErrorBoundary";
import { LABEL_ID, SITE_URL, buildPageJsonLd } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


export const Route = createFileRoute("/engine")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: "Create Your Track — Hybrid AI Records" },
      {
        name: "description",
        content:
          "Create Your Track with Hybrid Engine 1.0 Alpha. Write lyrics, pick a style, set vocals, and download a mastered track in minutes — one Hybrid Token per generation.",
      },
      { property: "og:title", content: "Create Your Track — Hybrid AI Records" },
      {
        property: "og:description",
        content:
          "Create Your Track with Hybrid Engine 1.0 Alpha. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://hybrid-ai-records.com/engine" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Create Your Track — Hybrid AI Records" },
      {
        name: "twitter:description",
        content:
          "Create Your Track with Hybrid Engine 1.0 Alpha. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
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
            name: "Create Your Track — Hybrid AI Records",
            description:
              "Create Your Track with Hybrid Engine 1.0 Alpha. Write lyrics, pick a style, set vocals, and download a mastered track in minutes.",
            breadcrumb: [{ name: "Create Your Track", path: "/engine" }],
            extra: [
              {
                "@type": ["WebApplication", "SoftwareApplication"],
                "@id": `${SITE_URL}/engine#app`,
                name: "Create Your Track",
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
  component: EngineRoutePage,
});

function EngineRoutePage() {
  return (
    <StudioErrorBoundary region="engine">
      <EngineStudio />
    </StudioErrorBoundary>
  );
}
