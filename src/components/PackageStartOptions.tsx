import type { ServicePackage } from "@/lib/services";

/**
 * "How to start (choose one)" block for the audio pipelines — the two intake
 * paths, the distribution answer, and the 10-track album bonus.
 */
export function PackageStartOptions({
  pkg,
  className = "",
}: {
  pkg: ServicePackage;
  className?: string;
}) {
  if (!pkg.startOptions?.length) return null;

  return (
    <div className={`bg-background/30 px-8 pb-7 backdrop-blur-sm ${className}`}>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        How to start — choose one
      </p>
      <ul className="mt-4 space-y-4">
        {pkg.startOptions.map((opt) => (
          <li key={opt.title} className="flex gap-3">
            <span aria-hidden className="mt-[2px] flex-none text-base leading-none">
              {opt.icon}
            </span>
            <span className="block text-sm leading-relaxed text-white/80">
              <span className="block font-semibold text-white">{opt.title}</span>
              {opt.body}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-5 space-y-3 border-t border-border/60 pt-4 text-sm">
        {pkg.distribution && (
          <div>
            <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Distribution
            </dt>
            <dd className="mt-1 leading-relaxed text-white/80">{pkg.distribution}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
