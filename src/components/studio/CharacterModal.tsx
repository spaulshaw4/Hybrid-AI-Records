import { useEffect, useState, type CSSProperties } from "react";

export interface VocalCharacter {
  id: string;
  name: string;
  timbreTag: string;
  isPublished: boolean;
  avatarUrl?: string;
  vocalId: string;
}

interface CharacterModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: VocalCharacter[];
  selectedCharacterId: string | null;
  onSelectCharacter: (char: VocalCharacter) => void;
  onOpenUpgradeModal: () => void;
  hasProLicense: boolean;
}

type CharacterTab = "Mine" | "Liked";

function tabStyle(active: boolean): CSSProperties {
  return {
    backgroundColor: active ? "rgba(6,182,212,0.15)" : "transparent",
    color: active ? "#06b6d4" : "#94a3b8",
    border: active ? "1px solid #06b6d4" : "1px solid transparent",
    borderRadius: 999,
    padding: "6px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function MicIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="#06b6d4" strokeWidth="1.6" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" stroke="#06b6d4" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 17v3.2" stroke="#06b6d4" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.5 20.2h7" stroke="#06b6d4" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function CharacterModal({
  isOpen,
  onClose,
  characters,
  selectedCharacterId,
  onSelectCharacter,
  onOpenUpgradeModal,
  hasProLicense,
}: CharacterModalProps) {
  const [activeTab, setActiveTab] = useState<CharacterTab>("Mine");

  useEffect(() => {
    if (isOpen) setActiveTab("Mine");
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreateClick = () => {
    if (!hasProLicense) {
      onOpenUpgradeModal();
      return;
    }
    window.alert("Opening vocal enrollment file uploader...");
  };

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
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Character"
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: "#161b26",
          color: "#f8fafc",
          colorScheme: "dark",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 620,
          minHeight: 460,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            padding: "20px 24px 8px",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>Character</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
              Choose a character to perform your song
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close character vault"
            style={{
              background: "transparent",
              backgroundColor: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            padding: "10px 24px 4px",
          }}
        >
          <div role="tablist" aria-label="Character library" style={{ display: "flex", gap: 8 }}>
            {(["Mine", "Liked"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                style={tabStyle(activeTab === tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={handleCreateClick}
              style={{
                background: "linear-gradient(90deg, #06b6d4, #0284c7)",
                backgroundColor: "#06b6d4",
                color: "#ffffff",
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              + Create character
            </button>
            {hasProLicense ? null : (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  right: -4,
                  backgroundColor: "#06b6d4",
                  color: "#0f172a",
                  fontSize: 10,
                  fontWeight: 900,
                  padding: "2px 6px",
                  borderRadius: 4,
                  lineHeight: 1.2,
                }}
              >
                Pro
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, padding: "16px 24px", overflowY: "auto" }}>
          {characters.length === 0 ? (
            <p style={{ margin: "40px 0 0", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
              No custom vocal characters enrolled yet.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: 16,
              }}
            >
              {characters.map((char) => {
                const isSelected = selectedCharacterId === char.id;
                return (
                  <button
                    key={char.id}
                    type="button"
                    onClick={() => {
                      onSelectCharacter(char);
                      onClose();
                    }}
                    style={{
                      height: 240,
                      background: "linear-gradient(180deg, #1e293b, #0f172a)",
                      backgroundColor: "#1e293b",
                      borderRadius: 12,
                      border: isSelected ? "2px solid #06b6d4" : "2px solid transparent",
                      cursor: "pointer",
                      position: "relative",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      padding: 16,
                      color: "#f8fafc",
                      overflow: "hidden",
                    }}
                  >
                    {char.isPublished ? (
                      <span
                        style={{
                          position: "absolute",
                          top: 12,
                          left: 12,
                          backgroundColor: "rgba(6,182,212,0.2)",
                          color: "#06b6d4",
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 4,
                        }}
                      >
                        Published
                      </span>
                    ) : null}
                    <div
                      style={{
                        position: "absolute",
                        top: 56,
                        width: 72,
                        height: 72,
                        borderRadius: "50%",
                        backgroundColor: "rgba(6,182,212,0.1)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                      }}
                    >
                      {char.avatarUrl ? (
                        <img
                          src={char.avatarUrl}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <MicIcon />
                      )}
                    </div>
                    <span
                      style={{
                        display: "block",
                        width: "100%",
                        fontSize: 14,
                        fontWeight: 700,
                        textAlign: "center",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {char.name}
                    </span>
                    <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "#94a3b8" }}>
                      {char.timbreTag}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 24px 16px",
            textAlign: "center",
            fontSize: 12,
            color: "#64748b",
          }}
        >
          No more data
        </div>
      </div>
    </div>
  );
}
