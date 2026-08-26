import { createFileRoute, Link } from "@tanstack/react-router";
import { Shield, FileText, Lock, Eye, Server, Mail, Scale } from "lucide-react";
import { pageHead } from "@/lib/social-meta";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { buildPageJsonLd } from "@/lib/release-schema";

export const Route = createFileRoute("/privacy")({
  errorComponent: RouteErrorFallback,
  component: PrivacyPage,
  head: () => ({
    ...pageHead({
      title: "Privacy Policy — Hybrid AI Records LLC",
      description:
        "Learn how Hybrid AI Records LLC collects, processes, and protects your data across the Hybrid Engine 1.0 Alpha, token purchases, and global distribution services.",
      socialTitle: "Privacy Policy — Hybrid AI Records LLC",
      socialDescription:
        "How we collect, process, and protect artist data, audio inputs, and transaction records on the Hybrid AI Records platform.",
      path: "/privacy",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/privacy",
            name: "Privacy Policy — Hybrid AI Records LLC",
            description:
              "How Hybrid AI Records LLC collects, processes, and protects artist data, audio inputs, and transaction records.",
            breadcrumb: [{ name: "Privacy Policy", path: "/privacy" }],
          }),
        ),
      },
    ],
  }),
});


interface PolicySection {
  id: string;
  icon: React.ReactNode;
  title: string;
  content: React.ReactNode;
}

function PrivacyPage() {
  const sections: PolicySection[] = [
    {
      id: "overview",
      icon: <Shield size={16} strokeWidth={1.75} />,
      title: "1. Overview & Scope",
      content: (
        <p>
          This Privacy Policy outlines how Hybrid AI Records LLC ("Company," "we," "us," or "our")
          collects, processes, and protects information when users access our platform, utilize the
          Hybrid Engine 1.0 Alpha, purchase tokens, or submit music for global distribution.
        </p>
      ),
    },
    {
      id: "collection",
      icon: <Eye size={16} strokeWidth={1.75} />,
      title: "2. Information We Collect",
      content: (
        <ul className="list-disc space-y-2 pl-5 marker:text-primary/60">
          <li>
            <strong className="text-foreground/80">Account & Identity Data:</strong> Name, email
            address, artist stage name, and basic contact details provided during registration or
            distribution setup.
          </li>
          <li>
            <strong className="text-foreground/80">User-Generated Content & Inputs:</strong> Text
            prompts, lyric entries, concept descriptions, and uploaded audio/vocal samples (e.g.,
            custom reference vocal takes) submitted into the Hybrid Engine 1.0 Alpha.
          </li>
          <li>
            <strong className="text-foreground/80">Transaction & Token Data:</strong> Records of
            token purchases (Hybrid Tokens, Artist Tokens), distribution fees ($25 package), and
            payout routing info. Note: Direct payment processing is securely handled via PCI-compliant
            gateways (e.g., Stripe); we do not store full credit card numbers on our servers.
          </li>
          <li>
            <strong className="text-foreground/80">Metadata & Release Assets:</strong> Cover artwork,
            track metadata, ISRC/UPC data, and songwriter/publishing credits required for digital store
            delivery.
          </li>
        </ul>
      ),
    },
    {
      id: "use",
      icon: <FileText size={16} strokeWidth={1.75} />,
      title: "3. How We Use and Process Your Data",
      content: (
        <ul className="list-disc space-y-2 pl-5 marker:text-primary/60">
          <li>
            <strong className="text-foreground/80">Audio & Lyric Generation:</strong> User prompts and
            vocal samples are processed exclusively to synthesize, arrange, and master tracks via our
            integrated Hybrid Engine pipelines.
          </li>
          <li>
            <strong className="text-foreground/80">Distribution & DSP Delivery:</strong> Metadata and
            finalized Master WAVs submitted through our $25 distribution pipeline are securely routed
            to our enterprise delivery partner (Too Lost) for dissemination across 450+ digital
            streaming platforms (DSPs).
          </li>
          <li>
            <strong className="text-foreground/80">Account Administration:</strong> Managing token
            balances, transaction receipts, and customer support.
          </li>
        </ul>
      ),
    },
    {
      id: "retention",
      icon: <Scale size={16} strokeWidth={1.75} />,
      title: "4. Data Retention & Audio Ownership",
      content: (
        <>
          <p>
            <strong className="text-foreground/80">Audio Inputs & Voice Takes:</strong> Uploaded voice
            clips used to create custom vocal styles are processed to execute synthesis and are retained
            only as necessary to fulfill user sessions and generation requests. We do not sell or license
            your custom vocal samples or private stems to third-party data brokers.
          </p>
          <p className="mt-3">
            <strong className="text-foreground/80">Commercial Ownership:</strong> As outlined in our
            Terms of Service, users retain ownership of their generated masters and distributed tracks,
            subject to platform terms and third-party warranty disclosures.
          </p>
        </>
      ),
    },
    {
      id: "providers",
      icon: <Server size={16} strokeWidth={1.75} />,
      title: "5. Third-Party Service Providers",
      content: (
        <>
          <p>
            We share information strictly with trusted enterprise partners essential to platform
            functionality:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-primary/60">
            <li>
              <strong className="text-foreground/80">Enterprise Distribution:</strong> Too Lost (for
              DSP ingestion, publishing registration, and Content ID management).
            </li>
            <li>
              <strong className="text-foreground/80">AI Synthesis Infrastructure:</strong> Secure cloud
              APIs executing text-to-lyrics and audio synthesis.
            </li>
            <li>
              <strong className="text-foreground/80">Payment Processors:</strong> Secure payment
              processors managing micro-transactions and enterprise services.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "security",
      icon: <Lock size={16} strokeWidth={1.75} />,
      title: "6. Security & Breach Notification",
      content: (
        <p>
          We employ industry-standard encryption protocols (SSL/TLS) to safeguard your data during
          transmission and storage. While no digital platform is 100% immune from security
          vulnerabilities, we maintain strict administrative controls to protect user assets and will
          notify affected users promptly in the event of any verified security incident.
        </p>
      ),
    },
    {
      id: "rights",
      icon: <Eye size={16} strokeWidth={1.75} />,
      title: "7. User Rights & Data Deletion Requests",
      content: (
        <p>
          Users have the right to review, update, or request the permanent deletion of their account
          data, uploaded audio takes, and transaction history by submitting a request through our
          official platform contact portal.
        </p>
      ),
    },
    {
      id: "amendments",
      icon: <FileText size={16} strokeWidth={1.75} />,
      title: "8. Policy Amendments",
      content: (
        <p>
          We reserve the right to update this policy to reflect platform updates, legal mandates, or
          workflow adjustments. Continued use of the platform following modifications constitutes
          acceptance of the revised terms.
        </p>
      ),
    },
    {
      id: "contact",
      icon: <Mail size={16} strokeWidth={1.75} />,
      title: "Contact & Legal Inquiries",
      content: (
        <p>
          Hybrid AI Records LLC |{" "}
          <Link
            to="/portal"
            className="text-primary underline-offset-2 hover:text-primary/80 hover:underline"
          >
            Support Portal
          </Link>
        </p>
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
            <span className="text-[#4b8bff]">RECORDS LLC</span>
          </div>

          <h1 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
            Privacy & Data Processing Policy
          </h1>

          <div className="mt-6 grid gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground sm:grid-cols-2">
            <div>
              <span className="text-primary">Effective Date:</span>{" "}
              <span className="text-foreground">August 2026</span>
            </div>
            <div>
              <span className="text-[#4b8bff]">Last Updated:</span>{" "}
              <span className="text-foreground">August 14, 2026</span>
            </div>
          </div>

          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-base sm:leading-[1.75]">
            This Privacy Policy outlines how Hybrid AI Records LLC collects, processes, and protects
            information when users access our platform, utilize the Hybrid Engine 1.0 Alpha, purchase tokens,
            or submit music for global distribution.
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
