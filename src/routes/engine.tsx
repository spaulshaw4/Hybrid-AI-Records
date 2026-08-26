import { createFileRoute } from "@tanstack/react-router";

import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { AudioStudio } from "@/components/AudioStudio";
import { StudioErrorBoundary } from "@/components/StudioErrorBoundary";
import { DEV_TEST_TOKEN_BALANCE, DEV_TEST_USER, isDevAuthBypass } from "@/lib/dev-auth";
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
  component: EnginePage,
});

function EnginePage() {
  return (
    <main
      id="engine-workspace"
      className="relative z-40 bg-[#0d0d11] py-3 text-white"
    >
      <div className="mx-auto mb-3 w-full max-w-7xl px-4 sm:px-6">
        <h1 className="sr-only">Create Your Track</h1>
        <PortalBreadcrumb
          trail={[{ label: "Create Your Track" }]}
        />
        {isDevAuthBypass() ? (
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-200">
            Dev test mode — signed in as {DEV_TEST_USER.email} · {DEV_TEST_TOKEN_BALANCE}{" "}
            Hybrid Tokens. Login is skipped on this route.
          </p>
        ) : null}
      </div>

      <section className="w-full px-4 sm:px-6">
        <StudioErrorBoundary region="engine">
          <AudioStudio />
        </StudioErrorBoundary>
      </section>
    </main>
  );
}
