import { useState } from "react";

interface BuyTokensModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const STRIPE_LINKS = {
  single: process.env.NEXT_PUBLIC_STRIPE_LINK_1_TOKEN || "https://buy.stripe.com/test_single_token",
  ep: process.env.NEXT_PUBLIC_STRIPE_LINK_5_TOKENS || "https://buy.stripe.com/test_5_tokens",
  album: process.env.NEXT_PUBLIC_STRIPE_LINK_12_TOKENS || "https://buy.stripe.com/test_12_tokens",
};

const PACKS: Array<{
  name: string;
  detail: string;
  detailColor: string;
  price: string;
  url: string;
  featured: boolean;
}> = [
  {
    name: "Single Track",
    detail: "1 Hybrid Token",
    detailColor: "#94a3b8",
    price: "$2.00",
    url: STRIPE_LINKS.single,
    featured: false,
  },
  {
    name: "EP Bundle (5 Tracks)",
    detail: "5 Hybrid Tokens",
    detailColor: "#94a3b8",
    price: "$10.00",
    url: STRIPE_LINKS.ep,
    featured: true,
  },
  {
    name: "Album Pack (12 Tracks)",
    detail: "Includes 2 Free Tokens",
    detailColor: "#34d399",
    price: "$20.00",
    url: STRIPE_LINKS.album,
    featured: false,
  },
];

export default function BuyTokensModal({ isOpen, onClose }: BuyTokensModalProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);
  if (!isOpen) return null;

  const handleCheckoutRedirect = (url: string) => {
    setIsRedirecting(true);
    window.location.href = url;
  };

  return (
    <div
      role="presentation"
      onClick={() => {
        if (!isRedirecting) onClose();
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
            disabled={isRedirecting}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: 20,
              cursor: isRedirecting ? "not-allowed" : "pointer",
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
        {isRedirecting ? (
          <div style={{ padding: "32px 0", textAlign: "center", color: "#fda4af", fontSize: 14, fontWeight: 600 }}>
            Redirecting to secure checkout...
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {PACKS.map((pack) => (
              <button
                key={pack.name}
                type="button"
                onClick={() => handleCheckoutRedirect(pack.url)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
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
                <span style={{ color: "#fda4af", fontWeight: 800, fontSize: 15, whiteSpace: "nowrap" }}>{pack.price}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={isRedirecting}
          style={{
            width: "100%",
            padding: "10px 0",
            background: "transparent",
            border: "none",
            color: "#64748b",
            fontSize: 12,
            cursor: isRedirecting ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
