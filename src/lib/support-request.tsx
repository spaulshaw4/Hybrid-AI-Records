import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { SERVICES } from "@/lib/services";

/**
 * Shared "what am I asking support about" state.
 *
 * A single persistent WhatsApp CTA reads this, so the tier and revision inputs
 * an artist picks anywhere in the Details panel are prefilled into one message
 * instead of being re-asked by several separate prompts.
 */
export type SupportRequest = {
  /** Package slug the artist picked, or null when they haven't chosen one yet. */
  tierSlug: string | null;
  /** Revision round the artist is asking about, when they set one. */
  round: number | null;
  /** Free-text revision notes captured from the upload panel. */
  notes: string;
};

type SupportRequestValue = SupportRequest & {
  setRequest: (patch: Partial<SupportRequest>) => void;
};

/** No package is assumed — the message stays generic until the artist selects a tier. */
const DEFAULTS: SupportRequest = {
  tierSlug: null,
  round: null,
  notes: "",
};

const SupportRequestContext = createContext<SupportRequestValue | null>(null);

export function SupportRequestProvider({ children }: { children: ReactNode }) {
  const [request, setState] = useState<SupportRequest>(DEFAULTS);

  const value = useMemo<SupportRequestValue>(
    () => ({
      ...request,
      setRequest: (patch) => setState((prev) => ({ ...prev, ...patch })),
    }),
    [request],
  );

  return (
    <SupportRequestContext.Provider value={value}>{children}</SupportRequestContext.Provider>
  );
}

/** Safe outside a provider: falls back to inert defaults. */
export function useSupportRequest(): SupportRequestValue {
  const ctx = useContext(SupportRequestContext);
  return ctx ?? { ...DEFAULTS, setRequest: () => {} };
}

/** Builds the prefilled WhatsApp message from the current selections. */
export function supportMessage(req: SupportRequest): string {
  const pkg = req.tierSlug ? SERVICES.find((s) => s.slug === req.tierSlug) : undefined;
  const lines = [
    pkg
      ? `Hi Hybrid AI Records — I'm on ${pkg.title} (${pkg.priceSingle}).`
      : "Hi Hybrid AI Records — I have a question about your packages.",
  ];
  if (req.round) lines.push(`Revision round: ${req.round}.`);
  if (req.notes.trim()) lines.push(`Revision notes: ${req.notes.trim().slice(0, 600)}`);
  lines.push("Can you help me with this?");
  return lines.join("\n");
}
