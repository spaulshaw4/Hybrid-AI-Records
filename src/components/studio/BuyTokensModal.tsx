interface BuyTokensModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccessCredit: (amount: number) => void;
}

const PACKS: Array<{
  name: string;
  detail: string;
  detailColor: string;
  price: string;
  tokens: number;
  featured: boolean;
}> = [
  {
    name: "Single Track",
    detail: "1 Hybrid Token",
    detailColor: "#94a3b8",
    price: "$2.00",
    tokens: 1,
    featured: false,
  },
  {
    name: "EP Bundle (5 Tracks)",
    detail: "5 Hybrid Tokens",
    detailColor: "#94a3b8",
    price: "$10.00",
    tokens: 5,
    featured: true,
  },
  {
    name: "Album Pack (12 Tracks)",
    detail: "Includes 2 Free Tokens",
    detailColor: "#34d399",
    price: "$20.00",
    tokens: 12,
    featured: false,
  },
];

export default function BuyTokensModal({ isOpen, onClose, onSuccessCredit }: BuyTokensModalProps) {
  if (!isOpen) return null;

  const handleCheckout = (tokenCount: number, price: string) => {
    onSuccessCredit(tokenCount);
    window.alert(`Added ${tokenCount} Hybrid Tokens (${price}) to your vault balance!`);
    onClose();
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
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
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>
            <span style={{ fontWeight: 900 }}>Ⓗ</span> Get Hybrid Tokens
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "#f8fafc",
              fontSize: 18,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45 }}>
          1 Token = 1 Master Release Track synthesized on Mureka 9.5 (WAV + MP3).
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {PACKS.map((pack) => (
            <button
              key={pack.name}
              type="button"
              onClick={() => handleCheckout(pack.tokens, pack.price)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                borderRadius: 10,
                padding: "12px 14px",
                backgroundColor: pack.featured ? "rgba(225, 29, 72, 0.08)" : "rgba(255,255,255,0.03)",
                border: pack.featured ? "1px solid rgba(225, 29, 72, 0.3)" : "1px solid rgba(255,255,255,0.08)",
                color: "#f8fafc",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{pack.name}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: pack.detailColor }}>{pack.detail}</span>
              </span>
              <span style={{ color: "#fda4af", fontWeight: 800, fontSize: 14, whiteSpace: "nowrap" }}>{pack.price}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#94a3b8",
            borderRadius: 10,
            padding: "10px 0",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
