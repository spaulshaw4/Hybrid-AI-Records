import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Scale,
  BadgeDollarSign,
  Coins,
  Mic,
  Globe,
  AlertTriangle,
  FileText,
  Mail,
} from "lucide-react";
import { pageHead } from "@/lib/social-meta";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { buildPageJsonLd } from "@/lib/release-schema";

export const Route = createFileRoute("/licensing")({
  component: LicensingPage,
  errorComponent: RouteErrorFallback,
  head: () => ({
    ...pageHead({
      title: "Licensing Policy & Terms — Hybrid AI Records LLC",
      description:
        "Master Commercial Licensing & Terms of Use for Hybrid Engine 1.0, token generation, and enterprise distribution.",
      socialTitle: "Licensing Policy — Hybrid AI Records LLC",
      socialDescription:
        "Commercial licensing terms for AI-generated masters, custom voice models, and global distribution via Hybrid AI Records.",
      path: "/licensing",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/licensing",
            name: "Licensing Policy & Terms — Hybrid AI Records LLC",
            description:
              "Master commercial licensing and terms of use for Hybrid Engine 1.0 masters, custom voice models, and global distribution.",
            breadcrumb: [{ name: "Licensing & Terms", path: "/licensing" }],
          }),
        ),
      },
    ],
  }),

});

interface LicenseSection {
  id: string;
  icon: React.ReactNode;
  title: string;
  content: React.ReactNode;
}

function LicensingPage() {
  const sections: LicenseSection[] = [
    {
      id: "grant",
      icon: <BadgeDollarSign size={16} strokeWidth={1.75} />,
      title: "1. Grant of License & Commercial Rights",
      content: (
        <>
          <p>
            Upon successful generation and redemption of platform tokens (e.g., Hybrid Tokens at
            $2.00) within the Hybrid Engine 1.0, Hybrid AI Records LLC grants the user a worldwide,
            non-exclusive (or exclusive upon verified unique synthesis), perpetual right to:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-primary/60">
            <li>
              Exploit, monetize, perform, stream, and broadcast the resulting master audio recordings.
            </li>
            <li>
              Synchronize generated audio to video, film, games, podcasts, advertisements, and social
              media content.
            </li>
            <li>
              Distribute the master recordings across digital streaming platforms (DSPs) independently
              or via our integrated $25 Distribution &amp; Spotlight pipeline.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "ownership",
      icon: <Coins size={16} strokeWidth={1.75} />,
      title: "2. Ownership & Intellectual Property",
      content: (
        <ul className="list-disc space-y-2 pl-5 marker:text-primary/60">
          <li>
            <strong className="text-foreground/80">User Ownership:</strong> Subject to compliance
            with these terms, the user retains all commercial exploitation rights and master revenue
            generated from the synthesized audio outputs.
          </li>
          <li>
            <strong className="text-foreground/80">Platform Exclusions:</strong> Hybrid AI Records LLC
            asserts no claim over backend streaming royalties earned by the creator, outside of agreed
            enterprise collection terms ($25 one-time distribution processing and standard 80/20
            enterprise collection/publishing facilitation).
          </li>
        </ul>
      ),
    },
    {
      id: "voice-models",
      icon: <Mic size={16} strokeWidth={1.75} />,
      title: "3. Custom Voice Models & Likeness Restrictions",
      content: (
        <ul className="list-disc space-y-2 pl-5 marker:text-primary/60">
          <li>
            <strong className="text-foreground/80">User-Uploaded Vocals:</strong> If a user uploads
            custom audio/vocal takes to synthesize or clone a vocal model within the Hybrid Engine 1.0,
            the user warrants that they own the rights to that voice or have obtained explicit, written
            authorization from the voice owner.
          </li>
          <li>
            <strong className="text-foreground/80">Anti-Impersonation Prohibitions:</strong> Users are
            strictly prohibited from generating, distributing, or monetizing outputs that
            intentionally mimic, clone, or infringe upon the proprietary voice likeness, name, or
            identity of protected commercial recording artists or public figures without legal
            clearance.
          </li>
          <li>
            <strong className="text-foreground/80">Breach &amp; Revocation:</strong> Any generation
            found to violate voice likeness or third-party intellectual property constitutes an immediate
            breach of this license, voiding all granted commercial rights and subjecting the release to
            instant takedown.
          </li>
        </ul>
      ),
    },
    {
      id: "distribution",
      icon: <Globe size={16} strokeWidth={1.75} />,
      title: "4. Distribution & Mechanical Clearances",
      content: (
        <ul className="list-disc space-y-2 pl-5 marker:text-primary/60">
          <li>
            Submitting a track through the $25 Enterprise Distribution package grants Hybrid AI Records
            LLC and its authorized distribution partners (including Too Lost) the administrative right
            to deliver metadata, artwork, and audio files to 450+ DSPs, manage Content ID registration,
            and collect/route royalties on behalf of the creator.
          </li>
          <li>
            The creator remains solely responsible for securing any necessary underlying mechanical,
            sample, or songwriting clearances if third-party copyrighted materials were manually
            integrated into the track.
          </li>
        </ul>
      ),
    },
    {
      id: "warranty",
      icon: <AlertTriangle size={16} strokeWidth={1.75} />,
      title: "5. Limitation of Warranty & \"As-Is\" Generation",
      content: (
        <p>
          All generative synthesis tools within the Hybrid Engine 1.0 are provided on an "as-is" and
          "as-available" basis. Hybrid AI Records LLC does not warrant that AI-generated audio is free
          from inadvertent sonic similarities to existing works. The user assumes full responsibility for
          legal due diligence prior to major commercial exploitation or third-party sync placements.
        </p>
      ),
    },
    {
      id: "termination",
      icon: <FileText size={16} strokeWidth={1.75} />,
      title: "6. Termination",
      content: (
        <p>
          Hybrid AI Records LLC reserves the right to terminate or revoke this commercial license for
          any specific asset if the user engages in fraudulent activity, copyright infringement,
          unauthorized voice impersonation, or platform abuse.
        </p>
      ),
    },
    {
      id: "contact",
      icon: <Mail size={16} strokeWidth={1.75} />,
      title: "Enterprise Licensing & Legal Inquiries",
      content: (
        <>
          <p>
            For enterprise licensing inquiries, custom master clearances, or legal notices, contact
            Hybrid AI Records LLC | Licensing &amp; Legal Operations.
          </p>
          <p className="mt-3">
            Visit the{" "}
            <Link
              to="/portal"
              className="text-primary underline-offset-2 hover:text-primary/80 hover:underline"
            >
              Support Portal
            </Link>{" "}
            for assistance.
          </p>
        </>
      ),
    },
  ];

  return (
    <main className="relative min-h-dvh bg-background pb-20 text-foreground">
      {/* subtle top accent line */}
      <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      <div className="mx-auto max-w-4xl px-6 py-12 sm:px-8 sm:py-16 lg:py-20">
        {/* Header card */}
        <section className="relative overflow-hidden border border-border/60 bg-background/60 p-6 backdrop-blur-sm sm:p-10">
          <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            <span className="text-primary">HYBRID</span>{" "}
            <span className="text-foreground">AI</span>{" "}
            <span className="text-muted-foreground">RECORDS LLC</span>
          </div>

          <h1 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
            Master Commercial Licensing & Terms of Use
          </h1>

          <div className="mt-6 grid gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground sm:grid-cols-2">
            <div>
              <span className="text-primary">Effective Date:</span>{" "}
              <span className="text-foreground">August 2026</span>
            </div>
            <div>
              <span className="text-muted-foreground">Last Updated:</span>{" "}
              <span className="text-foreground">August 14, 2026</span>
            </div>
          </div>

          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-base sm:leading-[1.75]">
            This licensing framework governs the commercial use of audio generated through the Hybrid
            Engine 1.0, token-based generation, and enterprise distribution services provided by Hybrid AI
            Records LLC.
          </p>
        </section>

        {/* Body sections */}
        <div className="mt-8 space-y-6">
          {sections.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="relative overflow-hidden border border-border/60 bg-background/60 p-6 backdrop-blur-sm transition-colors hover:border-primary/20 sm:p-8"
            >
              <div className="mb-4 flex items-center gap-2.5">
                <div className="grid h-7 w-7 place-items-center rounded border border-primary/30 bg-primary/10 text-primary/90">
                  {s.icon}
                </div>
                <h2 className="font-display text-lg font-semibold text-foreground sm:text-xl">
                  {s.title}
                </h2>
              </div>
              <div className="text-[14px] leading-7 text-muted-foreground/90 sm:text-[15px] sm:leading-[1.8]">
                {s.content}
              </div>
            </section>
          ))}
        </div>

        {/* Footer / back link */}
        <div className="mt-12 flex flex-col items-center justify-center gap-4 border-t border-border/60 pt-8 sm:flex-row sm:justify-between">
          <p className="text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
            © Hybrid AI Records LLC. All Rights Reserved.
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 border border-border px-5 py-2.5 text-xs font-semibold uppercase tracking-widest text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
