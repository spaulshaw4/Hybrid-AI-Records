import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface BuyTokensModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Unused. Token credit happens in the Stripe webhook, not in the browser. */
  onSuccessCredit?: (tokens: number) => void;
}

type TokenTier = "single" | "ep" | "album";

const PACKS: Array<{
  tier: TokenTier;
  name: string;
  detail: string;
  detailColor: string;
  price: string;
  featured: boolean;
}> = [
  {
    tier: "single",
    name: "Single Track",
    detail: "1 Hybrid Token",
    detailColor: "#94a3b8",
    price: "$2.00",
    featured: false,
  },
  {
    tier: "ep",
    name: "EP Bundle (5 Tracks)",
    detail: "5 Hybrid Tokens",
    detailColor: "#94a3b8",
    price: "$10.00",
    featured: true,
  },
  {
    tier: "album",
    name: "Album Pack (12 Tracks)",
    detail: "Includes 2 Free Tokens",
    detailColor: "#34d399",
    price: "$20.00",
    featured: false,
  },
];

export default function BuyTokensModal({ isOpen, onClose }: BuyTokensModalProps) {
  const [loadingTier, setLoadingTier] = useState<TokenTier | null>(null);
  if (!isOpen) return null;

  const busy = loadingTier !== null;

  const handleCheckout = async (tier: TokenTier) => {
    let userId = "";
    let accessToken = "";
    try {
      const { data } = await supabase.auth.getSession();
      userId = data.session?.user?.id ?? "";
      accessToken = data.session?.access_token ?? "";
    } catch {
      userId = "";
    }
    if (!userId || userId === "guest_user") {
      window.location.href = "/auth?next=/engine";
      return;
    }

    setLoadingTier(tier);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      };
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({ tier, userId }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      alert(data.error || "Unable to start checkout session.");
      setLoadingTier(null);
    } catch {
      alert("Network error connecting to billing service.");
      setLoadingTier(null);
    }
  };

  return (
    <div
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        backgroundColor: "rgba(0,0,0,0.8)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Get Hybrid Tokens"
        aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          backgroundColor: "#130b14",
          color: "#f8fafc",
          border: "1px solid rgba(244, 63, 94, 0.3)",
          borderRadius: 14,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.8)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>
            <span style={{ fontWeight: 900 }}>Ⓗ</span> Get Hybrid Tokens
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: 20,
              cursor: busy ? "not-allowed" : "pointer",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.45 }}>
          1 Token = 1 Master Release Track (WAV + MP3).
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {PACKS.map((pack) => (
            <button
              key={pack.tier}
              type="button"
              disabled={busy}
              onClick={() => void handleCheckout(pack.tier)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                width: "100%",
                textAlign: "left",
                cursor: busy ? "not-allowed" : "pointer",
                borderRadius: 8,
                padding: "14px 16px",
                backgroundColor: pack.featured ? "rgba(225, 29, 72, 0.08)" : "rgba(255,255,255,0.03)",
                border: pack.featured ? "1px solid rgba(225, 29, 72, 0.3)" : "1px solid rgba(255,255,255,0.1)",
                color: "#f8fafc",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{pack.name}</span>
                <span style={{ fontSize: 11, color: pack.detailColor }}>{pack.detail}</span>
              </span>
              <span style={{ color: "#fda4af", fontWeight: 800, fontSize: 15, whiteSpace: "nowrap" }}>
                {loadingTier === pack.tier ? "Loading..." : pack.price}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          style={{
            width: "100%",
            padding: "10px 0",
            background: "transparent",
            border: "none",
            color: "#64748b",
            fontSize: 12,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
