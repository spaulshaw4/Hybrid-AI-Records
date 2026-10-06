import { useEffect, useState, type CSSProperties } from "react";

export interface SavedPromptItem {
  id: string;
  title: string;
  prompt: string;
  timestamp: number;
  isBookmarked: boolean;
}

interface MyPromptsModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: SavedPromptItem[];
  onSelectPrompt: (promptText: string) => void;
  onToggleBookmark: (id: string) => void;
}

type PromptTab = "bookmarks" | "history";

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

const pillStyle = (active: boolean): CSSProperties => ({
  backgroundColor: active ? "#f8fafc" : "transparent",
  color: active ? "#0f172a" : "#94a3b8",
  border: "none",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

export default function MyPromptsModal({
  isOpen,
  onClose,
  items,
  onSelectPrompt,
  onToggleBookmark,
}: MyPromptsModalProps) {
  const [activeTab, setActiveTab] = useState<PromptTab>("history");

  useEffect(() => {
    if (!isOpen) setActiveTab("history");
  }, [isOpen]);

  if (!isOpen) return null;

  const visible = activeTab === "bookmarks" ? items.filter((item) => item.isBookmarked) : items;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
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
        aria-label="My prompts"
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: "#161b26",
          color: "#f8fafc",
          colorScheme: "dark",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 620,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px 8px",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f8fafc" }}>My prompts</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              backgroundColor: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, padding: "8px 20px 14px" }} role="tablist" aria-label="Prompt lists">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "bookmarks"}
            onClick={() => setActiveTab("bookmarks")}
            style={pillStyle(activeTab === "bookmarks")}
          >
            Bookmarks
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            onClick={() => setActiveTab("history")}
            style={pillStyle(activeTab === "history")}
          >
            History
          </button>
        </div>

        <div style={{ padding: "0 20px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.length === 0 ? (
            <p style={{ margin: "28px 8px", fontSize: 13, lineHeight: 1.5, color: "#94a3b8", textAlign: "center" }}>
              {activeTab === "bookmarks"
                ? "No bookmarked prompts yet. Click the bookmark icon on any prompt to save it here."
                : "No generation history logged yet."}
            </p>
          ) : (
            visible.map((item) => (
              <div
                key={item.id}
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                  borderRadius: 10,
                  padding: "12px 12px 10px",
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectPrompt(item.prompt);
                    onClose();
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    backgroundColor: "transparent",
                    border: "none",
                    color: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "#f8fafc" }}>
                    {item.title.trim() || "Untitled"}
                  </span>
                  <span
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      marginTop: 6,
                      fontSize: 13,
                      lineHeight: 1.45,
                      color: "#cbd5e1",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {item.prompt}
                  </span>
                  <span style={{ display: "block", marginTop: 8, fontSize: 12, color: "#64748b" }}>
                    {formatRelativeTime(item.timestamp)}
                  </span>
                </button>
                <button
                  type="button"
                  title={item.isBookmarked ? "Remove bookmark" : "Add to bookmarks"}
                  aria-label={item.isBookmarked ? "Remove bookmark" : "Add to bookmarks"}
                  aria-pressed={item.isBookmarked}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleBookmark(item.id);
                  }}
                  style={{
                    background: "transparent",
                    backgroundColor: "transparent",
                    border: "none",
                    color: item.isBookmarked ? "#f43f5e" : "#64748b",
                    cursor: "pointer",
                    fontSize: 16,
                    lineHeight: 1,
                    padding: 2,
                    flexShrink: 0,
                  }}
                >
                  {item.isBookmarked ? "🔖" : "📑"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
