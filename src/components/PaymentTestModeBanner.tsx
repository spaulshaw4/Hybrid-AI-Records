const clientToken = import.meta.env.VITE_PAYMENTS_CLIENT_TOKEN as string | undefined;

export function PaymentTestModeBanner() {
  if (!clientToken) {
    return (
      <div
        role="region"
        aria-label="Payment configuration notice"
        className="w-full border-b border-white/10 bg-transparent px-4 py-2 text-center text-sm text-slate-300"
      >
        <span className="font-semibold text-white">Checkout not live.</span>{" "}
        Set <code className="text-white/90">VITE_PAYMENTS_CLIENT_TOKEN</code> to
        your Stripe <code className="text-white/90">pk_live_…</code> key as a
        Railway build variable, then redeploy.
      </div>
    );
  }
  if (clientToken.startsWith("pk_test_")) {
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
