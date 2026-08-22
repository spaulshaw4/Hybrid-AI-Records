import { createFileRoute } from "@tanstack/react-router";

import { HeaderTokenBalance } from "@/components/HeaderTokenBalance";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { AudioStudio } from "@/components/AudioStudio";
import { DEV_TEST_TOKEN_BALANCE, DEV_TEST_USER, isDevAuthBypass } from "@/lib/dev-auth";
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
      className="relative z-10 min-h-[calc(100dvh-var(--site-header-height)-var(--site-dock-height))] bg-[#0d0d11] py-6 text-white sm:py-8"
    >
      <div className="mx-auto mb-8 w-full max-w-7xl px-4 sm:px-6">
        <PortalBreadcrumb
          trail={[{ label: "Hybrid Engine 1.0" }]}
          end={<HeaderTokenBalance />}
        />
        <div className="mt-4 border-b border-white/10 pb-4">
          <h1 className="text-2xl font-black uppercase tracking-wider text-red-500">
            Hybrid Engine 1.0
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Your sound, your workflow. Choose pure AI generation or build hybrid tracks with tailored vocals and master-grade finishing.
          </p>
          {isDevAuthBypass() ? (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-200">
              Dev test mode — signed in as {DEV_TEST_USER.email} · {DEV_TEST_TOKEN_BALANCE}{" "}
              Hybrid Tokens. Login is skipped on this route.
            </p>
          ) : null}
        </div>
      </div>

      <section className="w-full px-4 sm:px-6">
        <AudioStudio />
      </section>
    </main>
  );
}
