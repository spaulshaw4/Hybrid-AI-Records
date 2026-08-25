const clientToken = import.meta.env.VITE_PAYMENTS_CLIENT_TOKEN as string | undefined;

export function PaymentTestModeBanner() {
  // Intentionally no "Checkout not live" banner when the publishable key is
  // missing from the client bundle — set VITE_PAYMENTS_CLIENT_TOKEN at Docker
  // build time on Railway so Stripe Checkout works.

  if (clientToken?.startsWith("pk_test_")) {
    return (
      <div
        role="region"
        aria-label="Payment test mode notice"
        className="w-full border-b border-white/10 bg-transparent px-4 py-2 text-center text-sm text-slate-300"
      >
        <span className="font-semibold text-white">Test mode.</span> Preview
        payments are not charged.{" "}
        <a
          href="https://docs.lovable.dev/features/payments#test-and-live-environments"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-white underline underline-offset-2"
        >
          Read more
        </a>
      </div>
    );
  }
  return null;
}
