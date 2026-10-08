interface VocalUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCompleteCheckout: () => void;
}

export default function VocalUpgradeModal({ isOpen, onClose, onCompleteCheckout }: VocalUpgradeModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 110,
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unlock Custom Vocal Studio"
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: "#161b26",
          color: "#f8fafc",
          colorScheme: "dark",
          border: "1px solid rgba(6,182,212,0.4)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 440,
          padding: "32px 28px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 12 }} aria-hidden="true">
          🎙️
        </div>
        <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 700, color: "#f8fafc" }}>
          Unlock Custom Vocal Studio
        </h2>
        <p style={{ margin: "0 0 24px", fontSize: 14, color: "#94a3b8", lineHeight: 1.5 }}>
          Create and train a permanent vocal profile from your own voice. Requires custom model
          provisioning.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            backgroundColor: "rgba(255,255,255,0.04)",
            borderRadius: 10,
            padding: "14px 16px",
            marginBottom: 20,
            textAlign: "left",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#f8fafc" }}>Creator Voice License</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>1 Lifetime Vocal Slot</div>
          </div>
          <div style={{ color: "#06b6d4", fontWeight: 800, fontSize: 14, whiteSpace: "nowrap" }}>
            5 Hybrid Tokens
          </div>
        </div>
        <button
          type="button"
          onClick={onCompleteCheckout}
          style={{
            width: "100%",
            padding: "12px 0",
            background: "linear-gradient(90deg, #06b6d4, #0284c7)",
            backgroundColor: "#06b6d4",
            color: "#ffffff",
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Unlock Vocal Slot
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 12,
            background: "transparent",
            backgroundColor: "transparent",
            border: "none",
            color: "#94a3b8",
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
