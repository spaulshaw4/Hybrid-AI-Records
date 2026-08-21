const TERMS = [
  "One-shoot deal — a single production day and a single finished cut.",
  "0 revisions — the delivered cut is the final cut.",
  "Delivery is final once the finished file is sent.",
  "No returns, refunds, or exchanges on video packages.",
];

export const VIDEO_TERMS_STORAGE_KEY = "hybrid:last-checkout-kind";

/** Compact, reusable summary of the one-shoot video deal terms. */
export function VideoDealTerms({
  className = "",
  title = "Video deal terms",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`border border-[#e11d2e]/40 bg-[#e11d2e]/5 px-5 py-4 text-start ${className}`}
    >
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-[#e11d2e]">
        {title}
      </h3>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-white/85">
        {TERMS.map((term) => (
          <li key={term} className="flex gap-2">
            <span aria-hidden className="mt-[0.35rem] h-1 w-1 flex-none rounded-full bg-[#e11d2e]" />
            <span>{term}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default VideoDealTerms;
