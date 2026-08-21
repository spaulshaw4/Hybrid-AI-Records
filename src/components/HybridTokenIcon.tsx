export function HybridTokenIcon({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border border-current font-bold leading-none ${className}`}
      aria-hidden="true"
    >
      H
    </span>
  );
}
